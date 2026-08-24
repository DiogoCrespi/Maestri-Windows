export const PROJECT_HISTORY_KEY = "maestri-project-history-v1";
export const MAX_RECENT_PROJECTS = 24;

export interface RecentProject {
  name: string;
  path: string;
  lastOpenedAt: string;
}

export interface ProjectStorageReader {
  getItem(key: string): string | null;
}

export interface ProjectStorageWriter extends ProjectStorageReader {
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function pathKey(path: string): string {
  return path.replace(/[\\/]+/g, "\\").replace(/\\+$/, "").toLowerCase();
}

export function isAbsoluteProjectPath(value: string): boolean {
  const path = value.trim();
  return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\") || path.startsWith("/");
}

export function normalizeProjectPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const path = value.trim();
  if (!path || path.length > 32768 || /[\u0000-\u001f\u007f]/.test(path) || !isAbsoluteProjectPath(path)) return null;
  if (path.startsWith("/") && !path.startsWith("//")) return path.replace(/\/+$/, "") || "/";
  let normalized = path.replace(/\//g, "\\");
  if (normalized.startsWith("\\\\")) {
    normalized = `\\\\${normalized.slice(2).replace(/\\+/g, "\\")}`;
  } else {
    normalized = normalized.replace(/\\+/g, "\\");
  }
  if (normalized.length > 3) normalized = normalized.replace(/\\+$/, "");
  return normalized;
}

export function workspacePathForProject(projectPath: string): string {
  const normalized = normalizeProjectPath(projectPath);
  if (!normalized) throw new Error("Projeto precisa de um caminho absoluto válido");
  const separator = normalized.endsWith("\\") || normalized.endsWith("/") ? "" : normalized.startsWith("/") ? "/" : "\\";
  return `${normalized}${separator}workspace.json`;
}

export function projectNameFromPath(projectPath: string): string {
  const normalized = normalizeProjectPath(projectPath) ?? projectPath.trim();
  const segments = normalized.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] || "Novo projeto";
}

function validName(value: unknown): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && value.trim().length <= 160
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function dedupeRecentProjects(entries: readonly unknown[]): RecentProject[] {
  const unique = new Map<string, RecentProject>();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const raw = entry as Partial<RecentProject>;
    const path = normalizeProjectPath(raw.path);
    if (!path || !validName(raw.name) || !validTimestamp(raw.lastOpenedAt)) continue;
    const candidate: RecentProject = {
      name: raw.name.trim(),
      path,
      lastOpenedAt: raw.lastOpenedAt,
    };
    const key = pathKey(path);
    const previous = unique.get(key);
    if (!previous || Date.parse(candidate.lastOpenedAt) > Date.parse(previous.lastOpenedAt)) {
      unique.set(key, candidate);
    }
  }
  return [...unique.values()]
    .sort((left, right) => Date.parse(right.lastOpenedAt) - Date.parse(left.lastOpenedAt))
    .slice(0, MAX_RECENT_PROJECTS);
}

export function readRecentProjects(storage: ProjectStorageReader): RecentProject[] {
  const raw = storage.getItem(PROJECT_HISTORY_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? dedupeRecentProjects(parsed) : [];
  } catch {
    return [];
  }
}

export function writeRecentProjects(storage: ProjectStorageWriter, entries: readonly RecentProject[]): RecentProject[] {
  const normalized = dedupeRecentProjects(entries);
  storage.setItem(PROJECT_HISTORY_KEY, JSON.stringify(normalized));
  return normalized;
}

export function rememberRecentProject(
  storage: ProjectStorageWriter,
  project: Pick<RecentProject, "name" | "path">,
  lastOpenedAt = new Date().toISOString(),
): RecentProject[] {
  return writeRecentProjects(storage, [
    ...readRecentProjects(storage),
    { name: project.name, path: project.path, lastOpenedAt },
  ]);
}

export function removeRecentProject(storage: ProjectStorageWriter, projectPath: string): RecentProject[] {
  const key = normalizeProjectPath(projectPath);
  if (!key) return readRecentProjects(storage);
  return writeRecentProjects(storage, readRecentProjects(storage).filter((entry) => pathKey(entry.path) !== pathKey(key)));
}

export async function validateRecentProjects(
  entries: readonly RecentProject[],
  loadWorkspace: (workspacePath: string) => Promise<unknown>,
): Promise<RecentProject[]> {
  const checked = await Promise.all(entries.map(async (entry) => {
    try {
      await loadWorkspace(workspacePathForProject(entry.path));
      return entry;
    } catch {
      return null;
    }
  }));
  return dedupeRecentProjects(checked.filter((entry): entry is RecentProject => entry !== null));
}

export function projectDirectoryFromWorkspacePath(workspacePath: string): string | null {
  const normalized = normalizeProjectPath(workspacePath);
  if (!normalized) return null;
  const separator = Math.max(normalized.lastIndexOf("\\"), normalized.lastIndexOf("/"));
  if (separator === 2 && /^[a-zA-Z]:\\/.test(normalized)) return normalizeProjectPath(normalized.slice(0, 3));
  if (separator <= 0) return null;
  return normalizeProjectPath(normalized.slice(0, separator));
}
