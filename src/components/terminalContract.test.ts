import { describe, expect, it } from "vitest";
import {
  applyTerminalSettings,
  applyScrollbackMetadata,
  terminalContentFromSettings,
  terminalGraphInput,
  terminalSettingsFromContent,
} from "./terminalContract";
import type { TerminalContent } from "../model/workspace";

const baseContent: TerminalContent = {
  id: "terminal-1",
  agentType: "shell",
  command: "old-command",
  name: "Old name",
  icon: "terminal",
  color: "#3b82f6",
  shellPath: "powershell.exe",
  workingDirectory: "C:\\work",
  status: "idle",
  isManager: false,
  monitorWithOmbro: false,
  autoScrollLocked: false,
  shortcutMode: { kind: "automatic" },
  scrollbackLineCount: 0,
};

describe("terminal canvas contract", () => {
  it("creates content without copying shellPath into command", () => {
    const content = terminalContentFromSettings("terminal-new", "Terminal 1", {
      name: "Maestro",
      shellPath: "C:\\Windows\\System32\\cmd.exe",
      workingDirectory: "C:\\repo",
      command: "omaestri check",
      args: ["/Q"],
      env: { FOO: "bar" },
      isManager: true,
    });

    expect(content).toMatchObject({
      id: "terminal-new",
      shellPath: "C:\\Windows\\System32\\cmd.exe",
      command: "omaestri check",
      args: ["/Q"],
      env: { FOO: "bar" },
      isManager: true,
    });
    expect(content.command).not.toBe(content.shellPath);
  });

  it("uses the workspace directory for a new terminal only when cwd is default", () => {
    const content = terminalContentFromSettings("terminal-project", "Terminal", undefined, "D:\\project");
    expect(content.workingDirectory).toBe("D:\\project");

    const custom = terminalContentFromSettings("terminal-custom", "Terminal", {
      name: "Custom",
      shellPath: "powershell.exe",
      workingDirectory: "E:\\other",
      isManager: false,
    }, "D:\\project");
    expect(custom.workingDirectory).toBe("E:\\other");
  });

  it("repairs legacy shellPath-as-command while preserving all edited fields", () => {
    const legacy = { ...baseContent, command: baseContent.shellPath };
    expect(terminalSettingsFromContent(legacy).command).toBeUndefined();

    const updated = applyTerminalSettings(legacy, {
      name: "Manager",
      shellPath: "pwsh.exe",
      workingDirectory: "C:\\repo",
      command: "omaestri list",
      args: ["-NoLogo"],
      env: { NODE_ENV: "test" },
      isManager: true,
    });
    expect(updated).toMatchObject({
      name: "Manager",
      shellPath: "pwsh.exe",
      command: "omaestri list",
      args: ["-NoLogo"],
      env: { NODE_ENV: "test" },
      isManager: true,
    });
  });

  it("resolves a restored legacy C root when reopening terminal settings", () => {
    const restored = terminalSettingsFromContent({ ...baseContent, workingDirectory: "C:\\" }, "D:\\projects\\demo");
    expect(restored.workingDirectory).toBe("D:\\projects\\demo");

    const custom = terminalSettingsFromContent({ ...baseContent, workingDirectory: "E:\\saved\\cwd" }, "D:\\projects\\demo");
    expect(custom.workingDirectory).toBe("E:\\saved\\cwd");
  });

  it("publishes manager metadata in the terminal graph input", () => {
    expect(terminalGraphInput("node-1", { ...baseContent, isManager: true })).toEqual({
      id: "terminal-1",
      name: "Old name",
      nodeType: "terminal",
      isManager: true,
    });
  });

  it("updates compatible scrollback metadata without changing terminal identity", () => {
    const updated = applyScrollbackMetadata(baseContent, {
      scrollbackFile: "C:\\Maestri\\scrollback\\terminal-1.log",
      scrollbackLineCount: 42.8,
    });

    expect(updated).toMatchObject({
      id: "terminal-1",
      scrollbackFile: "C:\\Maestri\\scrollback\\terminal-1.log",
      scrollbackLineCount: 42,
    });
    expect(baseContent.scrollbackFile).toBeUndefined();
    expect(baseContent.scrollbackLineCount).toBe(0);
  });
});
