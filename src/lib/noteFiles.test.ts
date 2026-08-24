import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createNoteFiles,
  type TauriInvoke,
} from "./noteFiles";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe("noteFiles", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("uses typed Tauri note_read and note_save commands", async () => {
    const invoke = vi.fn<TauriInvoke>();
    invoke.mockResolvedValueOnce(undefined).mockResolvedValueOnce("# Native note");
    const notes = createNoteFiles({ runtime: "tauri", invoke });

    await notes.save("notes/one.md", "# Native note");
    await expect(notes.read("notes/one.md")).resolves.toBe("# Native note");

    expect(invoke).toHaveBeenNthCalledWith(1, "note_save", {
      path: "notes/one.md",
      content: "# Native note",
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "note_read", {
      path: "notes/one.md",
    });
  });

  it("persists note content in localStorage on the web fallback", async () => {
    const storage = new MemoryStorage();
    const notes = createNoteFiles({ runtime: "web", storage });

    await notes.save("notes/web.md", "web content");
    await expect(notes.read("notes/web.md")).resolves.toBe("web content");
    expect(storage.getItem("custom:notes/web.md")).toBeNull();

    const customNotes = createNoteFiles({
      runtime: "web",
      storage,
      storagePrefix: "custom:",
    });
    await customNotes.save("notes/custom.md", "custom content");
    expect(storage.getItem("custom:notes/custom.md")).toBe("custom content");
  });

  it("reports a typed not-found error in the web fallback", async () => {
    const notes = createNoteFiles({ runtime: "web", storage: new MemoryStorage() });

    await expect(notes.read("missing.md")).rejects.toMatchObject({
      name: "NoteFileError",
      code: "not_found",
      path: "missing.md",
    });
  });

  it("does not silently fall back to localStorage after a native failure", async () => {
    const invoke = vi.fn<TauriInvoke>().mockRejectedValue(new Error("native unavailable"));
    const storage = new MemoryStorage();
    const notes = createNoteFiles({ runtime: "tauri", invoke, storage });

    await expect(notes.save("native.md", "content")).rejects.toMatchObject({
      code: "save_failed",
    });
    expect(storage.length).toBe(0);
  });

  it("rejects invalid paths before invoking either backend", async () => {
    const invoke = vi.fn<TauriInvoke>();
    const notes = createNoteFiles({ runtime: "tauri", invoke });

    await expect(notes.read("   ")).rejects.toMatchObject({ code: "invalid_path" });
    await expect(notes.save("bad\0path", "content")).rejects.toMatchObject({
      code: "invalid_path",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects non-string native read responses", async () => {
    const invoke = vi.fn<TauriInvoke>().mockResolvedValue({ content: "wrong" });
    const notes = createNoteFiles({ runtime: "tauri", invoke });

    await expect(notes.read("note.md")).rejects.toMatchObject({
      code: "invalid_response",
      path: "note.md",
    });
  });
});
