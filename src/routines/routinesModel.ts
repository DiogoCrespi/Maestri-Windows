export type RoutineAction =
  | { kind: "command"; command: string }
  | { kind: "reminder"; reminder: string };

export type SchedulePattern =
  | { kind: "once"; timestampMs: number }
  | { kind: "every"; intervalSeconds: number }
  | { kind: "daily"; hour: number; minute: number; timeZone?: string }
  | { kind: "weekly"; daysOfWeek: number[]; hour: number; minute: number; timeZone?: string }; // 0 = Sunday, 6 = Saturday

export type ExecutionLimit =
  | { kind: "indefinite" }
  | { kind: "maxCount"; maxCount: number }
  | { kind: "untilTimestamp"; untilTimestampMs: number };

export interface Routine {
  id: string;
  name: string;
  targetTerminalId: string;
  action: RoutineAction;
  schedule: SchedulePattern;
  limit: ExecutionLimit;
  enabled: boolean;
  preRunScript?: string | null;
  noNotify: boolean;
  executionCount: number;
  firstRunAtMs?: number | null;
  lastRunAtMs?: number | null;
  createdAtMs: number;
}

export interface RoutineOperationResult {
  success: boolean;
  routineId?: string | null;
  message?: string | null;
}

export interface RoutineStatusEventPayload {
  routineId: string;
  status: "dispatched" | "completed" | "failed";
  timestampMs: number;
  targetTerminalId?: string;
  idempotencyKey?: string;
  message?: string;
}

export interface RoutineReminderEventPayload {
  routineId: string;
  targetTerminalId: string;
  message: string;
  timestampMs: number;
  idempotencyKey?: string;
}

export interface RoutinesDocument {
  schemaVersion: number;
  workspacePath?: string | null;
  routines: Routine[];
}

export const ROUTINES_SCHEMA_VERSION = 2;
export const MAX_ID_LEN = 128;
export const MAX_NAME_LEN = 256;
export const MAX_COMMAND_LEN = 4096;
export const MAX_TARGET_LEN = 128;
export const MAX_ROUTINES_COUNT = 1000;

export function validateRoutine(routine: Routine): string | null {
  if (!routine.id || !routine.id.trim() || routine.id.length > MAX_ID_LEN) {
    return "Routine ID is invalid or exceeds maximum length";
  }
  if (!routine.name || !routine.name.trim() || routine.name.length > MAX_NAME_LEN) {
    return "Routine name is invalid or exceeds maximum length";
  }
  if (
    !routine.targetTerminalId ||
    !routine.targetTerminalId.trim() ||
    routine.targetTerminalId.length > MAX_TARGET_LEN
  ) {
    return "Target terminal ID is invalid or exceeds maximum length";
  }

  if (routine.action.kind === "command") {
    if (!routine.action.command || !routine.action.command.trim() || routine.action.command.length > MAX_COMMAND_LEN) {
      return "Command action cannot be empty or exceed maximum length";
    }
  } else if (routine.action.kind === "reminder") {
    if (!routine.action.reminder || !routine.action.reminder.trim() || routine.action.reminder.length > MAX_COMMAND_LEN) {
      return "Reminder text cannot be empty or exceed maximum length";
    }
  }

  if (routine.schedule.kind === "once") {
    if (!routine.schedule.timestampMs || routine.schedule.timestampMs <= 0) {
      return "Once schedule timestamp must be positive";
    }
    if (routine.limit.kind === "untilTimestamp" && routine.schedule.timestampMs >= routine.limit.untilTimestampMs) {
      return "Once schedule timestamp cannot be at or past UntilTimestamp limit";
    }
  } else if (routine.schedule.kind === "every") {
    if (!routine.schedule.intervalSeconds || routine.schedule.intervalSeconds <= 0) {
      return "Every schedule interval must be greater than zero";
    }
  } else if (routine.schedule.kind === "daily") {
    if (
      routine.schedule.hour < 0 ||
      routine.schedule.hour > 23 ||
      routine.schedule.minute < 0 ||
      routine.schedule.minute > 59
    ) {
      return "Daily schedule hour (0-23) or minute (0-59) out of bounds";
    }
  } else if (routine.schedule.kind === "weekly") {
    if (
      !Array.isArray(routine.schedule.daysOfWeek) ||
      routine.schedule.daysOfWeek.length === 0 ||
      routine.schedule.daysOfWeek.some((d) => d < 0 || d > 6) ||
      routine.schedule.hour < 0 ||
      routine.schedule.hour > 23 ||
      routine.schedule.minute < 0 ||
      routine.schedule.minute > 59
    ) {
      return "Weekly schedule days (0-6), hour (0-23) or minute (0-59) out of bounds";
    }
  }

  if (routine.limit.kind === "maxCount") {
    if (routine.limit.maxCount < 0) {
      return "Max count limit cannot be negative";
    }
  } else if (routine.limit.kind === "untilTimestamp") {
    if (!routine.limit.untilTimestampMs || routine.limit.untilTimestampMs <= 0) {
      return "Until timestamp limit must be positive";
    }
  }

  if (routine.preRunScript && routine.preRunScript.length > MAX_COMMAND_LEN) {
    return "Pre-run script exceeds maximum length";
  }

  return null;
}

export function parseRoutineDefensively(raw: unknown): Routine | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, any>;

  try {
    const id = String(r.id || "");
    const name = String(r.name || "");
    const targetTerminalId = String(r.targetTerminalId || r.target_terminal_id || "");

    let action: RoutineAction;
    if (r.action && typeof r.action === "object") {
      if (r.action.kind === "reminder" || "reminder" in r.action || "Reminder" in r.action) {
        const text = r.action.reminder || r.action.Reminder || "";
        action = { kind: "reminder", reminder: String(text) };
      } else {
        const cmd = r.action.command || r.action.Command || "";
        action = { kind: "command", command: String(cmd) };
      }
    } else {
      return null;
    }

    let schedule: SchedulePattern;
    if (r.schedule && typeof r.schedule === "object") {
      const s = r.schedule;
      if (s.kind === "once" || "once" in s || "Once" in s) {
        const ts = s.timestampMs || s.timestamp || (s.Once && (s.Once.timestampMs || s.Once.timestamp)) || 0;
        schedule = { kind: "once", timestampMs: Number(ts) };
      } else if (s.kind === "every" || "every" in s || "Every" in s) {
        const sec = s.intervalSeconds || s.interval_seconds || (s.Every && s.Every.interval_seconds) || 60;
        schedule = { kind: "every", intervalSeconds: Number(sec) };
      } else if (s.kind === "daily" || "daily" in s || "Daily" in s) {
        const h = s.hour ?? (s.Daily && s.Daily.hour) ?? 0;
        const m = s.minute ?? (s.Daily && s.Daily.minute) ?? 0;
        schedule = { kind: "daily", hour: Number(h), minute: Number(m), timeZone: s.timeZone || s.time_zone };
      } else if (s.kind === "weekly" || "weekly" in s || "Weekly" in s) {
        const dow = s.daysOfWeek || (s.dayOfWeek !== undefined ? [s.dayOfWeek] : undefined) || (s.Weekly && [s.Weekly.day_of_week]) || [0];
        const h = s.hour ?? (s.Weekly && s.Weekly.hour) ?? 0;
        const m = s.minute ?? (s.Weekly && s.Weekly.minute) ?? 0;
        schedule = {
          kind: "weekly",
          daysOfWeek: Array.isArray(dow) ? dow.map(Number) : [Number(dow)],
          hour: Number(h),
          minute: Number(m),
          timeZone: s.timeZone || s.time_zone,
        };
      } else {
        return null;
      }
    } else {
      return null;
    }

    let limit: ExecutionLimit;
    if (r.limit && typeof r.limit === "object") {
      const l = r.limit;
      if (l.kind === "maxCount" || "maxCount" in l || "MaxCount" in l) {
        const cnt = l.maxCount || l.max_count || (l.MaxCount && l.MaxCount._0) || 1;
        limit = { kind: "maxCount", maxCount: Number(cnt) };
      } else if (l.kind === "untilTimestamp" || l.kind === "untilTimestampMs" || "untilTimestampMs" in l || "untilTimestamp" in l || "UntilTimestamp" in l) {
        const until = l.untilTimestampMs || l.untilTimestamp || (l.UntilTimestamp && (l.UntilTimestamp.untilTimestampMs || l.UntilTimestamp._0)) || 0;
        limit = { kind: "untilTimestamp", untilTimestampMs: Number(until) };
      } else {
        limit = { kind: "indefinite" };
      }
    } else {
      limit = { kind: "indefinite" };
    }

    const routine: Routine = {
      id,
      name,
      targetTerminalId,
      action,
      schedule,
      limit,
      enabled: Boolean(r.enabled),
      preRunScript: r.preRunScript || r.pre_run_script || null,
      noNotify: Boolean(r.noNotify || r.no_notify),
      executionCount: Number(r.executionCount || r.execution_count || 0),
      firstRunAtMs: r.firstRunAtMs || r.first_run_at ? Number(r.firstRunAtMs || r.first_run_at) : null,
      lastRunAtMs: r.lastRunAtMs || r.last_run_at ? Number(r.lastRunAtMs || r.last_run_at) : null,
      createdAtMs: Number(r.createdAtMs || r.created_at || Date.now()),
    };

    if (validateRoutine(routine) !== null) return null;
    return routine;
  } catch {
    return null;
  }
}
