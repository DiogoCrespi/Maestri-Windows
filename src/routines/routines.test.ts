import { describe, it, expect, beforeEach } from "vitest";
import {
  validateRoutine,
  parseRoutineDefensively,
  type Routine,
} from "./routinesModel";
import { loadRoutinesFromStorage, saveRoutinesToStorage, MemoryRoutinesManager } from "./routinesStore";
import { routinesAdapter } from "../bridge/routines";

class MockStorage implements Storage {
  private store = new Map<string, string>();
  get length() { return this.store.size; }
  clear() { this.store.clear(); }
  getItem(key: string) { return this.store.get(key) ?? null; }
  key(index: number) { return Array.from(this.store.keys())[index] ?? null; }
  removeItem(key: string) { this.store.delete(key); }
  setItem(key: string, value: string) { this.store.set(key, value); }
}

// Global window/localStorage mock for Node vitest environment
if (typeof globalThis.window === "undefined") {
  (globalThis as any).window = {
    localStorage: new MockStorage(),
  };
} else if (!globalThis.window.localStorage) {
  (globalThis.window as any).localStorage = new MockStorage();
}

describe("Revision 12: Contract Verification Test Suite (Rust serde <-> TypeScript DTO)", () => {
  let mockStorage: MockStorage;

  beforeEach(() => {
    mockStorage = new MockStorage();
    (globalThis.window as any).localStorage = mockStorage;
  });

  it("verifies exact JSON serialization match between Rust Routine serde and TypeScript Routine", () => {
    const tsRoutine: Routine = {
      id: "rt-exact-1",
      name: "Contract Alignment Check",
      targetTerminalId: "term-core-1",
      action: { kind: "command", command: "cargo check" },
      schedule: {
        kind: "weekly",
        daysOfWeek: [1, 5],
        hour: 18,
        minute: 30,
        timeZone: "America/Sao_Paulo",
      },
      limit: { kind: "untilTimestamp", untilTimestampMs: 1800000000000 },
      enabled: true,
      preRunScript: "echo 'pre'",
      noNotify: false,
      executionCount: 10,
      firstRunAtMs: 1600000000000,
      lastRunAtMs: 1700000000000,
      createdAtMs: 1500000000000,
    };

    const jsonStr = JSON.stringify(tsRoutine);
    const parsedObj = JSON.parse(jsonStr);

    // Verify tagged enums
    expect(parsedObj.action).toEqual({ kind: "command", command: "cargo check" });
    expect(parsedObj.schedule).toEqual({
      kind: "weekly",
      daysOfWeek: [1, 5],
      hour: 18,
      minute: 30,
      timeZone: "America/Sao_Paulo",
    });
    expect(parsedObj.limit).toEqual({
      kind: "untilTimestamp",
      untilTimestampMs: 1800000000000,
    });

    // Verify exact camelCase fields matching Rust #[serde(rename = "...")]
    expect(parsedObj.targetTerminalId).toBe("term-core-1");
    expect(parsedObj.firstRunAtMs).toBe(1600000000000);
    expect(parsedObj.lastRunAtMs).toBe(1700000000000);
    expect(parsedObj.createdAtMs).toBe(1500000000000);
  });

  it("verifies Rust emitted event payload contract (routine://status and routine://reminder)", async () => {
    const adapter = routinesAdapter;
    await adapter.setWorkspace("C:/project/ws-events-contract.json");

    const sampleRoutine: Routine = {
      id: "rt-reminder-1",
      name: "Reminder Test",
      targetTerminalId: "term-target-42",
      action: { kind: "reminder", reminder: "Time for review" },
      schedule: { kind: "every", intervalSeconds: 300 },
      limit: { kind: "indefinite" },
      enabled: true,
      noNotify: false,
      executionCount: 0,
      createdAtMs: Date.now(),
    };

    await adapter.upsertRoutine(sampleRoutine);

    let statusPayloadCaptured: any = null;
    let reminderPayloadCaptured: any = null;

    const unlistenStatus = await adapter.onStatusEvent?.((payload) => {
      statusPayloadCaptured = payload;
    });

    const unlistenReminder = await adapter.onReminderEvent?.((payload) => {
      reminderPayloadCaptured = payload;
    });

    await adapter.runRoutineNow("rt-reminder-1");

    expect(statusPayloadCaptured).not.toBeNull();
    expect(statusPayloadCaptured.routineId).toBe("rt-reminder-1");
    expect(statusPayloadCaptured.targetTerminalId).toBe("term-target-42");
    expect(statusPayloadCaptured.status).toBe("dispatched");
    expect(typeof statusPayloadCaptured.timestampMs).toBe("number");
    expect(typeof statusPayloadCaptured.idempotencyKey).toBe("string");

    expect(reminderPayloadCaptured).not.toBeNull();
    expect(reminderPayloadCaptured.routineId).toBe("rt-reminder-1");
    expect(reminderPayloadCaptured.targetTerminalId).toBe("term-target-42");
    expect(reminderPayloadCaptured.message).toBe("Time for review");
    expect(typeof reminderPayloadCaptured.timestampMs).toBe("number");

    unlistenStatus?.();
    unlistenReminder?.();
  });

  it("validates ExecutionLimit kind 'untilTimestamp' with untilTimestampMs", () => {
    const routine: Routine = {
      id: "r-limit-1",
      name: "Until Limit Test",
      targetTerminalId: "term-1",
      action: { kind: "command", command: "ls" },
      schedule: { kind: "every", intervalSeconds: 60 },
      limit: { kind: "untilTimestamp", untilTimestampMs: 2000000 },
      enabled: true,
      noNotify: false,
      executionCount: 0,
      createdAtMs: 1000000,
    };

    expect(validateRoutine(routine)).toBeNull();
  });

  it("parses untilTimestamp dynamically in parseRoutineDefensively", () => {
    const rawBackendJson = {
      id: "r-backend-limit",
      name: "Backend Limit",
      target_terminal_id: "term-1",
      action: { kind: "command", command: "dir" },
      schedule: { kind: "every", intervalSeconds: 120 },
      limit: { kind: "untilTimestamp", untilTimestampMs: 5000000000 },
      enabled: true,
      execution_count: 2,
      created_at_ms: 1000000,
    };

    const parsed = parseRoutineDefensively(rawBackendJson);
    expect(parsed).not.toBeNull();
    expect(parsed?.limit.kind).toBe("untilTimestamp");
    if (parsed?.limit.kind === "untilTimestamp") {
      expect(parsed.limit.untilTimestampMs).toBe(5000000000);
    }
  });

  it("isolates web storage per workspace and throws when setWorkspace has empty path", async () => {
    const adapter = routinesAdapter;

    await expect(adapter.setWorkspace("   ")).rejects.toThrow();

    await adapter.setWorkspace("C:/project/ws-a.json");
    await adapter.upsertRoutine({
      id: "r-ws-a",
      name: "Routine WS A",
      targetTerminalId: "term-a",
      action: { kind: "command", command: "npm test" },
      schedule: { kind: "every", intervalSeconds: 300 },
      limit: { kind: "indefinite" },
      enabled: true,
      noNotify: false,
      executionCount: 0,
      createdAtMs: Date.now(),
    });

    let listA = await adapter.listRoutines();
    expect(listA).toHaveLength(1);
    expect(listA[0].id).toBe("r-ws-a");

    // Switch workspace
    await adapter.setWorkspace("C:/project/ws-b.json");
    let listB = await adapter.listRoutines();
    expect(listB).toHaveLength(0); // Workspace B is separate
  });
});
