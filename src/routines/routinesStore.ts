import {
  type Routine,
  type RoutinesDocument,
  ROUTINES_SCHEMA_VERSION,
  MAX_ROUTINES_COUNT,
  validateRoutine,
  parseRoutineDefensively,
} from "./routinesModel";
import { routinesAdapter } from "../bridge/routines";

const STORAGE_KEY = "maestri-routines-v2";

export function loadRoutinesFromStorage(storage: Storage = window.localStorage): Routine[] {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const doc = JSON.parse(raw) as RoutinesDocument;
    if (!doc || typeof doc !== "object" || !Array.isArray(doc.routines)) {
      return [];
    }
    return doc.routines.map(parseRoutineDefensively).filter((r): r is Routine => r !== null);
  } catch {
    return [];
  }
}

export function saveRoutinesToStorage(routines: Routine[], storage: Storage = window.localStorage): void {
  const doc: RoutinesDocument = {
    schemaVersion: ROUTINES_SCHEMA_VERSION,
    routines,
  };
  storage.setItem(STORAGE_KEY, JSON.stringify(doc));
}

export class MemoryRoutinesManager {
  private routines: Routine[];

  constructor(initialRoutines: Routine[] = []) {
    this.routines = [...initialRoutines];
  }

  getRoutines(): Routine[] {
    return [...this.routines];
  }

  addRoutine(input: Omit<Routine, "id" | "executionCount" | "createdAtMs">): { routine?: Routine; error?: string } {
    if (this.routines.length >= MAX_ROUTINES_COUNT) {
      return { error: "Maximum routines limit reached" };
    }

    const now = Date.now();
    const newRoutine: Routine = {
      ...input,
      id: crypto.randomUUID(),
      executionCount: 0,
      createdAtMs: now,
    };

    const error = validateRoutine(newRoutine);
    if (error) return { error };

    this.routines.push(newRoutine);
    return { routine: newRoutine };
  }

  updateRoutine(id: string, updates: Partial<Routine>): { routine?: Routine; error?: string } {
    const idx = this.routines.findIndex((r) => r.id === id);
    if (idx < 0) return { error: "Routine not found" };

    const updated: Routine = {
      ...this.routines[idx],
      ...updates,
      id,
    };

    const error = validateRoutine(updated);
    if (error) return { error };

    this.routines[idx] = updated;
    return { routine: updated };
  }

  toggleRoutine(id: string, enabled?: boolean): boolean {
    const idx = this.routines.findIndex((r) => r.id === id);
    if (idx < 0) return false;
    this.routines[idx].enabled = enabled ?? !this.routines[idx].enabled;
    return true;
  }

  triggerRun(id: string): boolean {
    const idx = this.routines.findIndex((r) => r.id === id);
    if (idx < 0) return false;

    const r = this.routines[idx];
    const now = Date.now();

    if (r.limit.kind === "maxCount" && r.executionCount >= r.limit.maxCount) {
      return false;
    }
    if (r.limit.kind === "untilTimestamp" && now >= r.limit.untilTimestampMs) {
      return false;
    }

    this.routines[idx] = {
      ...r,
      executionCount: r.executionCount + 1,
      firstRunAtMs: r.firstRunAtMs ?? now,
      lastRunAtMs: now,
    };

    return true;
  }

  removeRoutine(id: string): boolean {
    const initialLen = this.routines.length;
    this.routines = this.routines.filter((r) => r.id !== id);
    return this.routines.length < initialLen;
  }
}
