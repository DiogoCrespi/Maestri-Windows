import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import {
  countScrollbackLines,
  limitScrollback,
  loadScrollback,
  recordWebScrollback,
} from "./scrollbackBridge";

class MemoryStorage {
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

describe("scrollback bridge", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("counts and limits history from the oldest side", () => {
    expect(countScrollbackLines("one\r\ntwo\rthree\n")).toBe(3);
    const ansi = "\u001b[31mkeep\u001b[0m\r\nlast\rfinal\n";
    expect(limitScrollback(`old\n${ansi}`, 3)).toBe(ansi);
    expect(limitScrollback("old\nkeep\nlast\n", 2)).toBe("keep\nlast\n");
    expect(limitScrollback("old\n😀😀\r\nlast", 2, 8)).toBe("\r\nlast");
  });

  it("uses a bounded web fallback without pretending it is native", async () => {
    const localStorage = new MemoryStorage();
    vi.stubGlobal("window", { localStorage });

    recordWebScrollback("terminal-web", "first\n", { scrollbackFile: null });
    recordWebScrollback("terminal-web", "second\n", { scrollbackFile: null });

    const restored = await loadScrollback({ terminalId: "terminal-web" });
    expect(restored).toMatchObject({
      data: "first\nsecond\n",
      scrollbackLineCount: 2,
      source: "web",
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("calls the native load contract and preserves returned metadata", async () => {
    const localStorage = new MemoryStorage();
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {}, localStorage });
    invokeMock.mockResolvedValue({
      data: "restored output\n",
      scrollbackFile: "C:\\Maestri\\scrollback\\terminal.log",
      scrollbackLineCount: 17,
    });

    const restored = await loadScrollback({
      terminalId: "terminal-native",
      scrollbackFile: "C:\\Maestri\\scrollback\\terminal.log",
      scrollbackLineCount: 12,
    });

    expect(invokeMock).toHaveBeenCalledWith("terminal_load_scrollback", {
      id: "terminal-native",
      maxLines: 1_000,
    });
    expect(restored).toEqual({
      data: "restored output\n",
      scrollbackFile: "C:\\Maestri\\scrollback\\terminal.log",
      scrollbackLineCount: 17,
      source: "native",
    });
  });
});
