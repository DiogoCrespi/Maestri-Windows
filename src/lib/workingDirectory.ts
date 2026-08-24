import { projectDirectoryFromWorkspacePath } from "../projectManager";

export const DEFAULT_WORKING_DIRECTORY = "C:\\";

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function isUsableWorkingDirectory(value: unknown): value is string {
  const path = trimmed(value);
  return path.length > 0
    && path.length <= 32768
    && !/[\u0000-\u001f\u007f]/.test(path)
    && (/^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\"));
}

export function isDefaultWorkingDirectory(value: unknown): boolean {
  const path = trimmed(value).replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  return path === "c:" || path === "" || path === "." || path === "\\";
}

export function workspaceFallbackDirectory(
  workspaceWorkingDirectory?: string | null,
  workspacePath?: string | null,
): string {
  const payloadDirectory = trimmed(workspaceWorkingDirectory);
  if (isUsableWorkingDirectory(payloadDirectory) && !isDefaultWorkingDirectory(payloadDirectory)) {
    return payloadDirectory;
  }

  const workspaceDirectory = projectDirectoryFromWorkspacePath(trimmed(workspacePath));
  if (workspaceDirectory) return workspaceDirectory;
  if (isUsableWorkingDirectory(payloadDirectory)) return payloadDirectory;
  return DEFAULT_WORKING_DIRECTORY;
}

/**
 * One rule for terminal cwd and FileTree roots:
 * explicit absolute non-default paths win; legacy/default/invalid values use
 * the workspace payload root, then the directory containing workspace.json.
 */
export function resolveWorkspaceWorkingDirectory(
  requestedDirectory?: string | null,
  workspaceWorkingDirectory?: string | null,
  workspacePath?: string | null,
): string {
  const requested = trimmed(requestedDirectory);
  if (isUsableWorkingDirectory(requested) && !isDefaultWorkingDirectory(requested)) {
    return requested;
  }
  return workspaceFallbackDirectory(workspaceWorkingDirectory, workspacePath);
}
