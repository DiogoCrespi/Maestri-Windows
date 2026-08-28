import { invoke as tauriInvoke } from "@tauri-apps/api/core";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

const DEFAULT_STORAGE_PREFIX = "maestri-note:";

export type NoteFilesRuntime = "tauri" | "web";
export type NoteFileErrorCode =
  | "invalid_path"
  | "storage_unavailable"
  | "not_found"
  | "read_failed"
  | "save_failed"
  | "invalid_response";

export interface NoteReadScopedArgs {
  workspaceRoot: string;
  resourcePath: string;
}

export interface NoteSaveScopedArgs {
  workspaceRoot: string;
  resourcePath: string;
  content: string;
}

export type TauriInvoke = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

export interface NoteFileStore {
  readonly runtime: NoteFilesRuntime;
  read(path: string): Promise<string>;
  save(path: string, content: string): Promise<void>;
  readScoped(workspaceRoot: string, resourcePath: string): Promise<string>;
  saveScoped(workspaceRoot: string, resourcePath: string, content: string): Promise<void>;
}

export interface CreateNoteFilesOptions {
  runtime?: NoteFilesRuntime;
  invoke?: TauriInvoke;
  storage?: Storage;
  storagePrefix?: string;
}

export class NoteFileError extends Error {
  readonly code: NoteFileErrorCode;
  readonly path?: string;

  constructor(code: NoteFileErrorCode, message: string, path?: string) {
    super(message);
    this.name = "NoteFileError";
    this.code = code;
    this.path = path;
  }
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && window.__TAURI_INTERNALS__ !== undefined;
}

function resolveStorage(storage?: Storage): Storage | undefined {
  if (storage) return storage;
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function validatePath(path: string): void {
  if (!path || !path.trim()) {
    throw new NoteFileError("invalid_path", "Note path must not be empty", path);
  }
  if (path.includes("\0")) {
    throw new NoteFileError("invalid_path", "Note path must not contain NUL", path);
  }
}

function isAbsolutePath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized) || normalized.startsWith("//");
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "Unknown note file error";
}

function storageKeyScoped(prefix: string, workspaceRoot: string, resourcePath: string): string {
  return `${prefix}${workspaceRoot}:${resourcePath}`;
}

function legacyManagedStorageKey(prefix: string, workspaceRoot: string, resourcePath: string): string {
  const root = workspaceRoot.replace(/[\\/]+$/, "");
  return `${prefix}${root}/notes/${resourcePath}`;
}

export function createNoteFiles(options: CreateNoteFilesOptions = {}): NoteFileStore {
  const runtime = options.runtime ?? (isTauriRuntime() ? "tauri" : "web");
  const invoke = options.invoke ?? (tauriInvoke as TauriInvoke);
  const storage = resolveStorage(options.storage);
  const prefix = options.storagePrefix ?? DEFAULT_STORAGE_PREFIX;

  return {
    runtime,

    async readScoped(workspaceRoot: string, resourcePath: string): Promise<string> {
      validatePath(workspaceRoot);
      validatePath(resourcePath);

      if (runtime === "tauri") {
        try {
          const content = await invoke("note_read_scoped", {
            workspaceRoot,
            resourcePath,
          } satisfies NoteReadScopedArgs);
          if (typeof content !== "string") {
            throw new NoteFileError(
              "invalid_response",
              "Tauri note_read_scoped returned a non-string value",
              resourcePath,
            );
          }
          return content;
        } catch (error) {
          if (error instanceof NoteFileError) throw error;
          throw new NoteFileError(
            "read_failed",
            `Failed to read note '${resourcePath}': ${errorMessage(error)}`,
            resourcePath,
          );
        }
      }

      if (!storage) {
        throw new NoteFileError(
          "storage_unavailable",
          "Web localStorage is unavailable",
          resourcePath,
        );
      }
      try {
        const scopedKey = storageKeyScoped(prefix, workspaceRoot, resourcePath);
        let content = storage.getItem(scopedKey);
        if (content === null) {
          content = storage.getItem(legacyManagedStorageKey(prefix, workspaceRoot, resourcePath));
          if (content !== null) {
            try {
              storage.setItem(scopedKey, content);
            } catch {
              // Reading a legacy note must not fail merely because migration
              // cannot write to a full or read-only storage implementation.
            }
          }
        }
        if (content === null) {
          throw new NoteFileError(
            "not_found",
            `Note '${resourcePath}' was not found in web storage for workspace '${workspaceRoot}'`,
            resourcePath,
          );
        }
        return content;
      } catch (error) {
        if (error instanceof NoteFileError) throw error;
        throw new NoteFileError(
          "read_failed",
          `Failed to read note '${resourcePath}' from web storage: ${errorMessage(error)}`,
          resourcePath,
        );
      }
    },

    async saveScoped(workspaceRoot: string, resourcePath: string, content: string): Promise<void> {
      validatePath(workspaceRoot);
      validatePath(resourcePath);

      if (runtime === "tauri") {
        try {
          await invoke("note_save_scoped", {
            workspaceRoot,
            resourcePath,
            content,
          } satisfies NoteSaveScopedArgs);
          return;
        } catch (error) {
          throw new NoteFileError(
            "save_failed",
            `Failed to save note '${resourcePath}': ${errorMessage(error)}`,
            resourcePath,
          );
        }
      }

      if (!storage) {
        throw new NoteFileError(
          "storage_unavailable",
          "Web localStorage is unavailable",
          resourcePath,
        );
      }
      try {
        storage.setItem(storageKeyScoped(prefix, workspaceRoot, resourcePath), content);
      } catch (error) {
        throw new NoteFileError(
          "save_failed",
          `Failed to save note '${resourcePath}' to web storage: ${errorMessage(error)}`,
          resourcePath,
        );
      }
    },

    async read(path: string): Promise<string> {
      validatePath(path);
      if (isAbsolutePath(path)) {
        throw new NoteFileError(
          "invalid_path",
          "Unconstrained absolute note paths are disabled for security. Use workspace managed notes instead.",
          path,
        );
      }
      if (runtime === "tauri") {
        throw new NoteFileError(
          "invalid_path",
          "Unconstrained note paths are disabled in native runtime. Use readScoped with workspaceRoot.",
          path,
        );
      }
      return this.readScoped("default-workspace", path);
    },

    async save(path: string, content: string): Promise<void> {
      validatePath(path);
      if (isAbsolutePath(path)) {
        throw new NoteFileError(
          "invalid_path",
          "Unconstrained absolute note paths are disabled for security. Use workspace managed notes instead.",
          path,
        );
      }
      if (runtime === "tauri") {
        throw new NoteFileError(
          "invalid_path",
          "Unconstrained note paths are disabled in native runtime. Use saveScoped with workspaceRoot.",
          path,
        );
      }
      return this.saveScoped("default-workspace", path, content);
    },
  };
}

export const noteFiles = createNoteFiles();
