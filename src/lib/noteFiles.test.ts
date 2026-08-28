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

  it("uses typed Tauri note_read_scoped and note_save_scoped commands", async () => {
    const invoke = vi.fn<TauriInvoke>();
    invoke.mockResolvedValueOnce(undefined).mockResolvedValueOnce("# Native note");
    const notes = createNoteFiles({ runtime: "tauri", invoke });

    await notes.saveScoped("C:/Workspaces/proj", "one.md", "# Native note");
    await expect(notes.readScoped("C:/Workspaces/proj", "one.md")).resolves.toBe("# Native note");

    expect(invoke).toHaveBeenNthCalledWith(1, "note_save_scoped", {
      workspaceRoot: "C:/Workspaces/proj",
      resourcePath: "one.md",
      content: "# Native note",
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "note_read_scoped", {
      workspaceRoot: "C:/Workspaces/proj",
      resourcePath: "one.md",
    });
  });

  it("persists note content in localStorage on the web fallback with readScoped", async () => {
    const storage = new MemoryStorage();
    const notes = createNoteFiles({ runtime: "web", storage });

    await notes.saveScoped("C:/Workspaces/proj", "web.md", "web content");
    await expect(notes.readScoped("C:/Workspaces/proj", "web.md")).resolves.toBe("web content");
    expect(storage.getItem("maestri-note:C:/Workspaces/proj:web.md")).toBe("web content");
  });

  it("keeps custom web storage prefixes workspace-scoped", async () => {
    const storage = new MemoryStorage();
    const notes = createNoteFiles({ runtime: "web", storage, storagePrefix: "custom:" });

    await notes.saveScoped("workspace-a", "note.md", "custom content");

    expect(storage.getItem("custom:workspace-a:note.md")).toBe("custom content");
    await expect(notes.readScoped("workspace-a", "note.md")).resolves.toBe("custom content");
  });

  it("migrates the previous managed-note web key on first scoped read", async () => {
    const storage = new MemoryStorage();
    storage.setItem("maestri-note:C:/Workspaces/proj/notes/legacy.md", "legacy content");
    const notes = createNoteFiles({ runtime: "web", storage });

    await expect(notes.readScoped("C:/Workspaces/proj", "legacy.md")).resolves.toBe("legacy content");
    expect(storage.getItem("maestri-note:C:/Workspaces/proj:legacy.md")).toBe("legacy content");
  });

  it("fail-closed security for unconstrained absolute paths", async () => {
    const invoke = vi.fn<TauriInvoke>();
    const notes = createNoteFiles({ runtime: "tauri", invoke });

    await expect(notes.read("C:/Windows/System32/config.txt")).rejects.toMatchObject({
      name: "NoteFileError",
      code: "invalid_path",
    });
    await expect(notes.save("/etc/passwd", "hacked")).rejects.toMatchObject({
      name: "NoteFileError",
      code: "invalid_path",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("reports a typed not-found error in the web fallback for readScoped", async () => {
    const notes = createNoteFiles({ runtime: "web", storage: new MemoryStorage() });

    await expect(notes.readScoped("ws-root", "missing.md")).rejects.toMatchObject({
      name: "NoteFileError",
      code: "not_found",
      path: "missing.md",
    });
  });

  it("does not silently fall back to localStorage after a native failure", async () => {
    const invoke = vi.fn<TauriInvoke>().mockRejectedValue(new Error("native unavailable"));
    const storage = new MemoryStorage();
    const notes = createNoteFiles({ runtime: "tauri", invoke, storage });

    await expect(notes.saveScoped("C:/ws", "native.md", "content")).rejects.toMatchObject({
      code: "save_failed",
    });
    expect(storage.length).toBe(0);
  });

  it("rejects invalid paths before invoking either backend", async () => {
    const invoke = vi.fn<TauriInvoke>();
    const notes = createNoteFiles({ runtime: "tauri", invoke });

    await expect(notes.readScoped("   ", "path.md")).rejects.toMatchObject({ code: "invalid_path" });
    await expect(notes.saveScoped("C:/ws", "bad\0path", "content")).rejects.toMatchObject({
      code: "invalid_path",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects non-string native scoped read responses", async () => {
    const invoke = vi.fn<TauriInvoke>().mockResolvedValue({ content: "wrong" });
    const notes = createNoteFiles({ runtime: "tauri", invoke });

    await expect(notes.readScoped("C:/ws", "note.md")).rejects.toMatchObject({
      code: "invalid_response",
      path: "note.md",
    });
  });
});
