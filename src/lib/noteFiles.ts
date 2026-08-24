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

export interface NoteReadArgs {
  path: string;
}

export interface NoteSaveArgs {
  path: string;
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
  if (!path.trim()) {
    throw new NoteFileError("invalid_path", "Note path must not be empty", path);
  }
  if (path.includes("\0")) {
    throw new NoteFileError("invalid_path", "Note path must not contain NUL", path);
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "Unknown note file error";
}

function storageKey(prefix: string, path: string): string {
  return `${prefix}${path}`;
}

export function createNoteFiles(options: CreateNoteFilesOptions = {}): NoteFileStore {
  const runtime = options.runtime ?? (isTauriRuntime() ? "tauri" : "web");
  const invoke = options.invoke ?? (tauriInvoke as TauriInvoke);
  const storage = resolveStorage(options.storage);
  const prefix = options.storagePrefix ?? DEFAULT_STORAGE_PREFIX;

  return {
    runtime,

    async read(path: string): Promise<string> {
      validatePath(path);

      if (runtime === "tauri") {
        try {
          const content = await invoke("note_read", {
            path,
          } satisfies NoteReadArgs);
          if (typeof content !== "string") {
            throw new NoteFileError(
              "invalid_response",
              "Tauri note_read returned a non-string value",
              path,
            );
          }
          return content;
        } catch (error) {
          if (error instanceof NoteFileError) throw error;
          throw new NoteFileError(
            "read_failed",
            `Failed to read note '${path}': ${errorMessage(error)}`,
            path,
          );
        }
      }

      if (!storage) {
        throw new NoteFileError(
          "storage_unavailable",
          "Web localStorage is unavailable",
          path,
        );
      }
      try {
        const content = storage.getItem(storageKey(prefix, path));
        if (content === null) {
          throw new NoteFileError(
            "not_found",
            `Note '${path}' was not found in web storage`,
            path,
          );
        }
        return content;
      } catch (error) {
        if (error instanceof NoteFileError) throw error;
        throw new NoteFileError(
          "read_failed",
          `Failed to read note '${path}' from web storage: ${errorMessage(error)}`,
          path,
        );
      }
    },

    async save(path: string, content: string): Promise<void> {
      validatePath(path);

      if (runtime === "tauri") {
        try {
          await invoke("note_save", {
            path,
            content,
          } satisfies NoteSaveArgs);
          return;
        } catch (error) {
          throw new NoteFileError(
            "save_failed",
            `Failed to save note '${path}': ${errorMessage(error)}`,
            path,
          );
        }
      }

      if (!storage) {
        throw new NoteFileError(
          "storage_unavailable",
          "Web localStorage is unavailable",
          path,
        );
      }
      try {
        storage.setItem(storageKey(prefix, path), content);
      } catch (error) {
        throw new NoteFileError(
          "save_failed",
          `Failed to save note '${path}' to web storage: ${errorMessage(error)}`,
          path,
        );
      }
    },
  };
}

export const noteFiles = createNoteFiles();
