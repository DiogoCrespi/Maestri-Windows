import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  type Routine,
  type RoutineOperationResult,
  type RoutineStatusEventPayload,
  type RoutineReminderEventPayload,
  validateRoutine,
} from "../routines/routinesModel";
import { desktopBridge } from "../lib/desktopBridge";

export interface RoutinesAdapter {
  isNative: boolean;
  setWorkspace: (workspacePath: string) => Promise<number>;
  listRoutines: () => Promise<Routine[]>;
  upsertRoutine: (routine: Routine) => Promise<RoutineOperationResult>;
  removeRoutine: (id: string) => Promise<boolean>;
  setRoutineEnabled: (id: string, enabled: boolean) => Promise<boolean>;
  runRoutineNow: (id: string) => Promise<boolean>;
  onStatusEvent?: (callback: (payload: RoutineStatusEventPayload) => void) => Promise<() => void>;
  onReminderEvent?: (callback: (payload: RoutineReminderEventPayload) => void) => Promise<() => void>;
}

// Workspace-scoped Web LocalStorage persistence fallback
const WEB_STORAGE_PREFIX = "maestri-routines-workspace:";
let activeWorkspacePath: string | null = null;
const statusListeners = new Set<(payload: RoutineStatusEventPayload) => void>();
const reminderListeners = new Set<(payload: RoutineReminderEventPayload) => void>();

function getWebRoutinesMap(workspacePath: string): Map<string, Routine> {
  const map = new Map<string, Routine>();
  try {
    const raw = window.localStorage.getItem(`${WEB_STORAGE_PREFIX}${workspacePath}`);
    if (raw) {
      const list = JSON.parse(raw) as Routine[];
      if (Array.isArray(list)) {
        list.forEach((r) => map.set(r.id, r));
      }
    }
  } catch {
    // Ignore storage parse errors
  }
  return map;
}

function saveWebRoutinesMap(workspacePath: string, map: Map<string, Routine>): void {
  try {
    const list = Array.from(map.values());
    window.localStorage.setItem(`${WEB_STORAGE_PREFIX}${workspacePath}`, JSON.stringify(list));
  } catch {
    // Ignore storage quota errors
  }
}

export const routinesAdapter: RoutinesAdapter = {
  get isNative() {
    return desktopBridge.isNative;
  },

  async setWorkspace(workspacePath: string) {
    const trimmedPath = workspacePath.trim();
    if (!trimmedPath) {
      throw new Error("workspacePath is required for routines operation");
    }

    activeWorkspacePath = trimmedPath;
    if (desktopBridge.isNative) {
      return invoke<number>("routine_set_workspace", { workspacePath: trimmedPath });
    }
    return getWebRoutinesMap(trimmedPath).size;
  },

  async listRoutines() {
    if (desktopBridge.isNative) {
      return invoke<Routine[]>("routine_list");
    }
    if (!activeWorkspacePath) return [];
    return Array.from(getWebRoutinesMap(activeWorkspacePath).values());
  },

  async upsertRoutine(routine) {
    const validationError = validateRoutine(routine);
    if (validationError) {
      return { success: false, routineId: routine.id, message: validationError };
    }

    if (desktopBridge.isNative) {
      return invoke<RoutineOperationResult>("routine_upsert", { routine });
    }

    if (!activeWorkspacePath) {
      return { success: false, routineId: routine.id, message: "No active workspace set" };
    }

    const map = getWebRoutinesMap(activeWorkspacePath);
    map.set(routine.id, { ...routine });
    saveWebRoutinesMap(activeWorkspacePath, map);
    return { success: true, routineId: routine.id };
  },

  async removeRoutine(id: string) {
    if (desktopBridge.isNative) {
      return invoke<boolean>("routine_remove", { id });
    }
    if (!activeWorkspacePath) return false;
    const map = getWebRoutinesMap(activeWorkspacePath);
    const removed = map.delete(id);
    if (removed) {
      saveWebRoutinesMap(activeWorkspacePath, map);
    }
    return removed;
  },

  async setRoutineEnabled(id: string, enabled: boolean) {
    if (desktopBridge.isNative) {
      return invoke<boolean>("routine_set_enabled", { id, enabled });
    }
    if (!activeWorkspacePath) return false;
    const map = getWebRoutinesMap(activeWorkspacePath);
    const existing = map.get(id);
    if (!existing) return false;
    map.set(id, { ...existing, enabled });
    saveWebRoutinesMap(activeWorkspacePath, map);
    return true;
  },

  async runRoutineNow(id: string) {
    if (desktopBridge.isNative) {
      return invoke<boolean>("routine_run_now", { id });
    }
    if (!activeWorkspacePath) return false;
    const map = getWebRoutinesMap(activeWorkspacePath);
    const existing = map.get(id);
    if (!existing) return false;

    const nowMs = Date.now();
    const idempotencyKey = `web-${id}-${nowMs}`;
    const updated: Routine = {
      ...existing,
      executionCount: existing.executionCount + 1,
      firstRunAtMs: existing.firstRunAtMs ?? nowMs,
      lastRunAtMs: nowMs,
    };
    map.set(id, updated);
    saveWebRoutinesMap(activeWorkspacePath, map);

    // Emit ONLY status: "dispatched" for web preview (Do NOT invent "completed")
    const statusPayload: RoutineStatusEventPayload = {
      routineId: id,
      targetTerminalId: existing.targetTerminalId,
      status: "dispatched",
      timestampMs: nowMs,
      idempotencyKey,
    };
    statusListeners.forEach((cb) => cb(statusPayload));

    if (existing.action.kind === "reminder") {
      const reminderPayload: RoutineReminderEventPayload = {
        routineId: id,
        targetTerminalId: existing.targetTerminalId,
        message: existing.action.reminder,
        timestampMs: nowMs,
        idempotencyKey,
      };
      reminderListeners.forEach((cb) => cb(reminderPayload));
    }

    return true;
  },

  async onStatusEvent(callback) {
    if (desktopBridge.isNative) {
      return listen<RoutineStatusEventPayload>("routine://status", (event) => callback(event.payload));
    }
    statusListeners.add(callback);
    return () => {
      statusListeners.delete(callback);
    };
  },

  async onReminderEvent(callback) {
    if (desktopBridge.isNative) {
      return listen<RoutineReminderEventPayload>("routine://reminder", (event) => callback(event.payload));
    }
    reminderListeners.add(callback);
    return () => {
      reminderListeners.delete(callback);
    };
  },
};
