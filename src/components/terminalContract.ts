import type { TerminalSettingsInitialValues, TerminalSettingsValue } from "./TerminalSettings";
import type { TerminalContent } from "../model/workspace";
import type { ScrollbackMetadata } from "../lib/scrollbackBridge";
import { resolveWorkspaceWorkingDirectory } from "../lib/workingDirectory";
import { shouldClearAgentSession } from "../lib/agentSession";

export interface TerminalGraphInput {
  id: string;
  name: string;
  nodeType: "terminal";
  isManager: boolean;
}

export function applyScrollbackMetadata(
  content: TerminalContent,
  metadata: Partial<ScrollbackMetadata>,
): TerminalContent {
  const lineCount = metadata.scrollbackLineCount;
  return {
    ...content,
    scrollbackFile: metadata.scrollbackFile ?? content.scrollbackFile ?? null,
    scrollbackLineCount: typeof lineCount === "number" && Number.isFinite(lineCount) && lineCount >= 0
      ? Math.floor(lineCount)
      : content.scrollbackLineCount,
  };
}

function normalizedCommand(command: string | undefined, shellPath: string): string | undefined {
  const value = command?.trim();
  if (!value || value.localeCompare(shellPath, undefined, { sensitivity: "accent" }) === 0) {
    return undefined;
  }
  return value;
}

function copyArgs(args: string[] | undefined): string[] | undefined {
  return args && args.length > 0 ? [...args] : undefined;
}

function copyEnv(env: Record<string, string> | undefined): Record<string, string> | undefined {
  return env && Object.keys(env).length > 0 ? { ...env } : undefined;
}

export function terminalContentFromSettings(
  id: string,
  fallbackName: string,
  settings?: TerminalSettingsValue,
  workspaceWorkingDirectory = "C:\\",
): TerminalContent {
  const shellPath = settings?.shellPath.trim() || "powershell.exe";
  return {
    id,
    agentType: settings?.agentType || "shell",
    // shellPath selects the executable; command is only the optional initial command.
    command: settings?.command?.trim() || "",
    name: settings?.name.trim() || fallbackName,
    icon: settings?.icon || "terminal",
    color: settings?.color || "#3b82f6",
    shellPath,
    workingDirectory: resolveWorkspaceWorkingDirectory(
      settings?.workingDirectory,
      workspaceWorkingDirectory,
    ),
    status: "idle",
    isManager: settings?.isManager ?? false,
    monitorWithOmbro: false,
    autoScrollLocked: false,
    shortcutMode: { kind: "automatic" },
    scrollbackLineCount: 0,
    args: copyArgs(settings?.args),
    env: copyEnv(settings?.env),
    assignedRoleId: settings?.assignedRoleId || null,
  };
}

export function applyTerminalSettings(
  content: TerminalContent,
  settings: TerminalSettingsValue,
  workspaceWorkingDirectory = "C:\\",
): TerminalContent {
  const shellPath = settings.shellPath.trim() || content.shellPath || "powershell.exe";
  const agentSession = shouldClearAgentSession(content, settings.agentType, settings.command)
    ? null
    : content.agentSession;
  return {
    ...content,
    name: settings.name.trim() || content.name,
    shellPath,
    command: settings.command?.trim() || "",
    workingDirectory: resolveWorkspaceWorkingDirectory(
      settings.workingDirectory,
      workspaceWorkingDirectory,
    ),
    args: copyArgs(settings.args),
    env: copyEnv(settings.env),
    isManager: settings.isManager,
    assignedRoleId: settings.assignedRoleId !== undefined ? settings.assignedRoleId : content.assignedRoleId,
    agentType: settings.agentType || content.agentType,
    color: settings.color || content.color,
    icon: settings.icon || content.icon,
    agentSession,
  };
}

export function terminalSettingsFromContent(
  content: TerminalContent,
  workspaceWorkingDirectory = "C:\\",
): TerminalSettingsInitialValues {
  return {
    name: content.name,
    shellPath: content.shellPath,
    workingDirectory: resolveWorkspaceWorkingDirectory(
      content.workingDirectory,
      workspaceWorkingDirectory,
    ),
    // Repair the old CanvasWorkspace shape where command duplicated shellPath.
    command: normalizedCommand(content.command, content.shellPath),
    args: copyArgs(content.args),
    env: copyEnv(content.env),
    isManager: content.isManager === true,
    assignedRoleId: content.assignedRoleId,
    agentType: content.agentType,
    color: content.color,
    icon: content.icon,
  };
}

export function terminalGraphInput(nodeId: string, content: Partial<TerminalContent>): TerminalGraphInput {
  return {
    id: content.id || nodeId,
    name: content.name?.trim() || "Terminal",
    nodeType: "terminal",
    isManager: content.isManager === true,
  };
}
