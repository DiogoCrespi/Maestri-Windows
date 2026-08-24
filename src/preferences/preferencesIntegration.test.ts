import { describe, expect, it } from "vitest";
import { applyTerminalSettings, terminalContentFromSettings, terminalSettingsFromContent } from "../components/terminalContract";
import { createPreferencesStore } from "./preferencesStore";

describe("Terminal Preset & Role Integration Contract", () => {
  it("populates agentType, color, icon and assignedRoleId from settings to content", () => {
    const content = terminalContentFromSettings("term-1", "My Terminal", {
      name: "Custom Agent Terminal",
      shellPath: "powershell.exe",
      workingDirectory: "C:\\projects",
      isManager: false,
      command: "claude --version",
      assignedRoleId: "role-code-architect",
      agentType: "claudeCode",
      color: "#8b5cf6",
      icon: "terminal",
    });

    expect(content.id).toBe("term-1");
    expect(content.name).toBe("Custom Agent Terminal");
    expect(content.agentType).toBe("claudeCode");
    expect(content.command).toBe("claude --version");
    expect(content.assignedRoleId).toBe("role-code-architect");
    expect(content.color).toBe("#8b5cf6");
  });

  it("applies settings updates while preserving assignedRoleId and agentType", () => {
    const initial = terminalContentFromSettings("term-2", "Original", {
      name: "Original",
      shellPath: "cmd.exe",
      workingDirectory: "C:\\",
      isManager: false,
    });

    const updated = applyTerminalSettings(initial, {
      name: "Updated Agent",
      shellPath: "powershell.exe",
      workingDirectory: "C:\\work",
      isManager: true,
      assignedRoleId: "role-test-engineer",
      agentType: "codex",
    });

    expect(updated.name).toBe("Updated Agent");
    expect(updated.isManager).toBe(true);
    expect(updated.assignedRoleId).toBe("role-test-engineer");
    expect(updated.agentType).toBe("codex");
  });

  it("retains assignedRoleId when converting content back to settings initial values", () => {
    const content = terminalContentFromSettings("term-3", "Test", {
      name: "Test",
      shellPath: "pwsh.exe",
      workingDirectory: "D:\\",
      isManager: false,
      assignedRoleId: "role-code-architect",
    });

    const settings = terminalSettingsFromContent(content);
    expect(settings.assignedRoleId).toBe("role-code-architect");
  });

  it("integrates full workflow: create preset -> create terminal with preset/role -> re-open settings", () => {
    const store = createPreferencesStore();
    const newPreset = store.addPreset({
      name: "Python Fast API",
      agentType: "genericShell",
      command: "python main.py",
      args: ["--port", "8000"],
      icon: "code",
      color: "#00ffaa",
    });

    const newRole = store.addRole({
      name: "Backend Dev",
      description: "FastAPI developer",
      systemPrompt: "Build APIs",
      allowedActions: ["list", "ask"],
      presetId: newPreset.id,
    });

    const content = terminalContentFromSettings("term-flow", "Flow Terminal", {
      name: "FastAPI Server",
      shellPath: "powershell.exe",
      workingDirectory: "C:\\app",
      isManager: false,
      command: newPreset.command,
      args: newPreset.args,
      assignedRoleId: newRole.id,
      agentType: newPreset.agentType,
      color: newPreset.color,
    });

    expect(content.command).toBe("python main.py");
    expect(content.assignedRoleId).toBe(newRole.id);
    expect(content.agentType).toBe("genericShell");

    // Reopen settings from content
    const reopenedSettings = terminalSettingsFromContent(content);
    expect(reopenedSettings.assignedRoleId).toBe(newRole.id);
    expect(reopenedSettings.command).toBe("python main.py");
  });
});
