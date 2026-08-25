import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import type { WorkspaceDocument } from "../model/workspace";

export interface CreateTerminalOptions {
  cols?: number;
  rows?: number;
  cwd?: string;
  /** Executable shell path/name. This is not the initial command. */
  shellPath?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface TerminalOutputPayload {
  terminalId: string;
  data: string;
}

export interface TerminalExitedPayload {
  terminalId: string;
  exitCode: number | null;
}

interface TerminalInfo {
  id: string;
  sessionToken: number;
}

export interface PortalInfo {
  id: string;
  name: string;
  currentUrl: string;
  title: string | null;
  isLoading: boolean;
  storageScope?: string;
}

export interface DesktopBridge {
  isNative: boolean;
  createPty?: (
    id: string,
    cols: number,
    rows: number,
    cwd?: string,
    shellPath?: string,
    args?: string[],
    env?: Record<string, string>,
    command?: string,
  ) => Promise<void>;
  writePty?: (id: string, data: string) => Promise<void>;
  resizePty?: (id: string, cols: number, rows: number) => Promise<void>;
  closePty?: (id: string) => Promise<void>;
  onPtyData?: (id: string, callback: (data: string) => void) => () => void;
  onPtyExit?: (id: string, callback: (code: number) => void) => () => void;

  createTerminal: (id: string, options?: CreateTerminalOptions) => Promise<void>;
  stopTerminal: (id: string) => Promise<void>;
  writeTerminal: (id: string, data: string) => Promise<void>;
  resizeTerminal: (id: string, cols: number, rows: number) => Promise<void>;
  onTerminalOutput: (callback: (payload: TerminalOutputPayload) => void) => Promise<() => void>;
  onTerminalExited: (callback: (payload: TerminalExitedPayload) => void) => Promise<() => void>;
  loadWorkspace: (path: string) => Promise<WorkspaceDocument>;
  workspacePathExists: (path: string) => Promise<boolean>;
  saveWorkspace: (path: string, document: WorkspaceDocument) => Promise<void>;
  replaceAccessGraph: (
    nodes: Array<{ id: string; name: string; nodeType?: string; resourcePath?: string | null }>,
    connections: Array<{ a: string; b: string }>,
  ) => Promise<number>;
  portalRegister: (id: string, name: string, initialUrl: string, storageScope?: string) => Promise<PortalInfo>;
  portalUnregister: (id: string) => Promise<boolean>;
  portalNavigate: (id: string, url: string) => Promise<PortalInfo>;
  portalReload: (id: string) => Promise<PortalInfo>;
  portalGoBack: (id: string) => Promise<PortalInfo>;
  portalGoForward: (id: string) => Promise<PortalInfo>;
  portalInspect: (id: string) => Promise<PortalInfo>;
  chooseWorkspaceToOpen: () => Promise<string | null>;
  chooseWorkspaceToSave: (defaultPath: string) => Promise<string | null>;
  chooseProjectDirectory: () => Promise<string | null>;
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

const dataListeners = new Map<string, Set<(data: string) => void>>();
const exitListeners = new Map<string, Set<(code: number) => void>>();
const globalOutputListeners = new Set<(payload: TerminalOutputPayload) => void>();
const globalExitListeners = new Set<(payload: TerminalExitedPayload) => void>();
const isNative = typeof window !== "undefined" && window.__TAURI_INTERNALS__ !== undefined;
let nativeListenersReady: Promise<void> | undefined;
const activeSessionTokens = new Map<string, number>();

function normalizeOutput(payload: TerminalOutputPayload & { terminal_id?: string }): TerminalOutputPayload {
  return { terminalId: payload.terminalId ?? payload.terminal_id ?? "", data: payload.data };
}

function normalizeExit(
  payload: TerminalExitedPayload & { terminal_id?: string; exit_code?: number | null; code?: number | null },
): TerminalExitedPayload {
  return {
    terminalId: payload.terminalId ?? payload.terminal_id ?? "",
    exitCode: payload.exitCode ?? payload.exit_code ?? payload.code ?? null,
  };
}

function ensureNativeListeners(): Promise<void> {
  if (!isNative) return Promise.resolve();
  if (!nativeListenersReady) {
    nativeListenersReady = Promise.all([
      listen<TerminalOutputPayload & { terminal_id?: string }>("terminal://output", ({ payload }) => {
        const event = normalizeOutput(payload);
        dataListeners.get(event.terminalId)?.forEach((callback) => callback(event.data));
        globalOutputListeners.forEach((callback) => callback(event));
      }),
      listen<TerminalExitedPayload & { terminal_id?: string; exit_code?: number | null; code?: number | null }>(
        "terminal://exited",
        ({ payload }) => {
          const event = normalizeExit(payload);
          exitListeners.get(event.terminalId)?.forEach((callback) => callback(event.exitCode ?? -1));
          globalExitListeners.forEach((callback) => callback(event));
        },
      ),
    ]).then(() => undefined);
  }
  return nativeListenersReady;
}

function emitBrowserOutput(id: string, data: string): void {
  dataListeners.get(id)?.forEach((callback) => callback(data));
  globalOutputListeners.forEach((callback) => callback({ terminalId: id, data }));
}

export const desktopBridge: DesktopBridge = {
  isNative,

  async createPty(
    id: string,
    cols: number,
    rows: number,
    cwd?: string,
    shellPath?: string,
    args?: string[],
    env?: Record<string, string>,
    command?: string,
  ) {
    if (isNative) {
      await ensureNativeListeners();
      const info = await invoke<TerminalInfo>("terminal_create", {
        id,
        cols,
        rows,
        cwd,
        // Rust keeps the wire name `shell` for compatibility; the public
        // TypeScript contract calls it shellPath to distinguish it from
        // the initial command.
        shell: shellPath,
        args,
        env,
        command,
      });
      activeSessionTokens.set(id, info.sessionToken);
    } else {
      setTimeout(() => {
        emitBrowserOutput(
          id,
          `\r\n\x1b[33m[Preview web: ConPTY disponível somente no app Tauri]\x1b[0m\r\nPS> `,
        );
      }, 50);
    }
  },

  async writePty(id: string, data: string) {
    if (isNative) {
      await invoke("terminal_write", { id, data });
    } else {
      if (data === "\r") {
        emitBrowserOutput(id, "\r\nPS> ");
      } else {
        emitBrowserOutput(id, data);
      }
    }
  },

  async resizePty(id: string, cols: number, rows: number) {
    if (isNative) {
      await invoke("terminal_resize", { id, cols, rows });
    }
  },

  async closePty(id: string) {
    if (isNative) {
      const expectedSessionToken = activeSessionTokens.get(id);
      activeSessionTokens.delete(id);
      await invoke("terminal_stop", { id, expectedSessionToken }).catch(() => undefined);
    }
    dataListeners.delete(id);
    exitListeners.delete(id);
  },

  onPtyData(id: string, callback: (data: string) => void) {
    if (!dataListeners.has(id)) {
      dataListeners.set(id, new Set());
    }
    dataListeners.get(id)!.add(callback);
    return () => {
      dataListeners.get(id)?.delete(callback);
    };
  },

  onPtyExit(id: string, callback: (code: number) => void) {
    if (!exitListeners.has(id)) {
      exitListeners.set(id, new Set());
    }
    exitListeners.get(id)!.add(callback);
    return () => {
      exitListeners.get(id)?.delete(callback);
    };
  },

  async createTerminal(id: string, options?: CreateTerminalOptions) {
    return this.createPty?.(
      id,
      options?.cols ?? 80,
      options?.rows ?? 24,
      options?.cwd,
      options?.shellPath,
      options?.args,
      options?.env,
      options?.command,
    );
  },

  async stopTerminal(id: string) {
    return this.closePty?.(id);
  },

  async writeTerminal(id: string, data: string) {
    return this.writePty?.(id, data);
  },

  async resizeTerminal(id: string, cols: number, rows: number) {
    return this.resizePty?.(id, cols, rows);
  },

  async onTerminalOutput(callback: (payload: TerminalOutputPayload) => void) {
    await ensureNativeListeners();
    globalOutputListeners.add(callback);
    return () => {
      globalOutputListeners.delete(callback);
    };
  },

  async onTerminalExited(callback: (payload: TerminalExitedPayload) => void) {
    await ensureNativeListeners();
    globalExitListeners.add(callback);
    return () => {
      globalExitListeners.delete(callback);
    };
  },

  async loadWorkspace(path: string) {
    if (isNative) return invoke<WorkspaceDocument>("workspace_load", { path });
    const value = window.localStorage.getItem(`maestri-workspace:${path}`);
    if (!value) throw new Error(`Workspace não encontrado no preview web: ${path}`);
    return JSON.parse(value) as WorkspaceDocument;
  },

  async workspacePathExists(path: string) {
    if (isNative) return invoke<boolean>("workspace_path_exists", { path });
    return window.localStorage.getItem(`maestri-workspace:${path}`) !== null;
  },

  async saveWorkspace(path: string, document: WorkspaceDocument) {
    if (isNative) {
      await invoke("workspace_save", { path, document });
      return;
    }
    window.localStorage.setItem(`maestri-workspace:${path}`, JSON.stringify(document));
  },

  async replaceAccessGraph(nodes, connections) {
    if (!isNative) return 0;
    return invoke<number>("access_graph_replace", { nodes, connections });
  },

  async portalRegister(id, name, initialUrl, storageScope) {
    const scope = storageScope ?? "isolated";
    if (!isNative) return { id, name, currentUrl: initialUrl, title: null, isLoading: false, storageScope: scope };
    return invoke<PortalInfo>("portal_register", { id, name, initialUrl, storageScope: scope });
  },

  async portalUnregister(id) {
    if (!isNative) return false;
    return invoke<boolean>("portal_unregister", { id });
  },

  async portalNavigate(id, url) {
    if (!isNative) return { id, name: "Portal", currentUrl: url, title: null, isLoading: false };
    return invoke<PortalInfo>("portal_navigate", { id, url });
  },

  async portalReload(id) {
    if (!isNative) return { id, name: "Portal", currentUrl: "about:blank", title: null, isLoading: false };
    return invoke<PortalInfo>("portal_reload", { id });
  },

  async portalGoBack(id) {
    if (!isNative) return { id, name: "Portal", currentUrl: "about:blank", title: null, isLoading: false };
    return invoke<PortalInfo>("portal_go_back", { id });
  },

  async portalGoForward(id) {
    if (!isNative) return { id, name: "Portal", currentUrl: "about:blank", title: null, isLoading: false };
    return invoke<PortalInfo>("portal_go_forward", { id });
  },

  async portalInspect(id) {
    if (!isNative) return { id, name: "Portal", currentUrl: "about:blank", title: null, isLoading: false };
    return invoke<PortalInfo>("portal_inspect", { id });
  },

  async chooseWorkspaceToOpen() {
    if (!isNative) return null;
    const selected = await openDialog({
      title: "Abrir workspace do Maestri",
      multiple: false,
      directory: false,
      filters: [{ name: "Workspace Maestri", extensions: ["json"] }],
    });
    return typeof selected === "string" ? selected : null;
  },

  async chooseWorkspaceToSave(defaultPath) {
    if (!isNative) return defaultPath;
    return saveDialog({
      title: "Salvar workspace do Maestri",
      defaultPath,
      filters: [{ name: "Workspace Maestri", extensions: ["json"] }],
    });
  },

  async chooseProjectDirectory() {
    if (!isNative) return null;
    const selected = await openDialog({
      title: "Escolher pasta do projeto Maestri",
      multiple: false,
      directory: true,
    });
    return typeof selected === "string" ? selected : null;
  },
};
