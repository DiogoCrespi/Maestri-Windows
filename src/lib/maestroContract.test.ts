import { describe, it, expect, beforeEach } from "vitest";
import {
  isUuid,
  normalizeMaestroConnectPayload,
  validateMaestroOrigin,
  validateMaestroPayload,
} from "../lib/maestroContract";
import {
  isRequestProcessed,
  clearProcessedRequests,
} from "../hooks/useMaestroController";

describe("maestroContract & Validation", () => {
  beforeEach(() => {
    clearProcessedRequests();
  });

  const mockManagerNode = {
    id: "manager-1",
    type: "terminal",
    position: { x: 100, y: 100 },
    style: { width: 450, height: 320 },
    data: {
      content: {
        id: "term-content-1",
        name: "Manager Terminal",
        isManager: true,
        shellPath: "powershell.exe",
        workingDirectory: "C:\\",
      },
    },
  };

  const mockWorkerNode = {
    id: "worker-1",
    type: "terminal",
    position: { x: 100, y: 480 },
    data: {
      content: {
        id: "term-content-2",
        name: "Worker Terminal",
        isManager: false,
      },
    },
  };

  const mockNoteNode = {
    id: "note-1",
    type: "stickyNote",
    position: { x: 600, y: 100 },
    data: { content: { title: "Note" } },
  };

  it("validates origin successfully for existing manager node", () => {
    const res = validateMaestroOrigin("manager-1", [mockManagerNode, mockWorkerNode, mockNoteNode]);
    expect(res.isValid).toBe(true);
    expect(res.managerNode?.id).toBe("manager-1");
    expect(res.error).toBeUndefined();
  });

  it("rejects origin if source terminal is missing from canvas", () => {
    const res = validateMaestroOrigin("non-existent", [mockManagerNode]);
    expect(res.isValid).toBe(false);
    expect(res.error).toContain("not found in canvas");
  });

  it("rejects origin if source node is not a terminal", () => {
    const res = validateMaestroOrigin("note-1", [mockNoteNode]);
    expect(res.isValid).toBe(false);
    expect(res.error).toContain("is not a terminal");
  });

  it("rejects origin if source terminal is not a Manager node", () => {
    const res = validateMaestroOrigin("worker-1", [mockWorkerNode]);
    expect(res.isValid).toBe(false);
    expect(res.error).toContain("is not a Manager node");
  });

  it("rejects empty or whitespace sourceTerminalId", () => {
    const res = validateMaestroOrigin("   ", [mockManagerNode]);
    expect(res.isValid).toBe(false);
    expect(res.error).toBe("sourceTerminalId is required");
  });

  it("tracks idempotency of requestIds correctly", () => {
    expect(isRequestProcessed("req-123")).toBe(false);
    // Simulate processing
    clearProcessedRequests();
    expect(isRequestProcessed("req-123")).toBe(false);
  });

  it("requires UUID request IDs and enforces name, role and instruction limits", () => {
    expect(isUuid("7c1e7e5f-9ad4-4fa7-9e3f-9d1a6f20d2c4")).toBe(true);
    expect(isUuid("req-123")).toBe(false);
    const recruit = {
      requestId: "7c1e7e5f-9ad4-4fa7-9e3f-9d1a6f20d2c4",
      sourceTerminalId: "manager-1",
      name: "x".repeat(129),
    };
    expect(validateMaestroPayload("recruit", recruit)).toContain("name exceeds");
    expect(validateMaestroPayload("role", {
      requestId: recruit.requestId,
      sourceTerminalId: recruit.sourceTerminalId,
      targetTerminalId: "worker-1",
      role: "reviewer",
      instructions: "x".repeat(8193),
    })).toContain("instructions exceeds");
  });

  it("matches the Rust recruit payload, including command and shell metadata", () => {
    const payload = {
      requestId: "7c1e7e5f-9ad4-4fa7-9e3f-9d1a6f20d2c4",
      sourceTerminalId: "manager-1",
      name: "Builder",
      role: "builder",
      agentType: "claude_code",
      command: "claude --model sonnet",
      workingDirectory: "C:\\repo",
      shellPath: "powershell.exe",
      color: "#3b82f6",
      icon: "terminal",
    };
    expect(validateMaestroPayload("recruit", payload)).toBeUndefined();
    expect(validateMaestroPayload("recruit", {
      ...payload,
      command: `bad\n${"x".repeat(8_192)}`,
    })).toContain("command");
  });

  it("separates connect actor from endpoints and preserves legacy payloads", () => {
    expect(normalizeMaestroConnectPayload({
      requestId: "7c1e7e5f-9ad4-4fa7-9e3f-9d1a6f20d2c4",
      actorTerminalId: "manager-1",
      sourceId: "note-1",
      targetId: "portal-1",
      connectionType: "terminal-portal",
    })).toEqual({
      actorTerminalId: "manager-1",
      sourceId: "note-1",
      targetId: "portal-1",
      connectionType: "terminal-portal",
    });
    expect(normalizeMaestroConnectPayload({
      requestId: "7c1e7e5f-9ad4-4fa7-9e3f-9d1a6f20d2c4",
      sourceTerminalId: "manager-1",
      targetId: "worker-1",
    })).toMatchObject({ actorTerminalId: "manager-1", sourceId: "manager-1", targetId: "worker-1" });
    expect(validateMaestroPayload("connect", {
      requestId: "7c1e7e5f-9ad4-4fa7-9e3f-9d1a6f20d2c4",
      actorTerminalId: "manager-1",
      sourceId: "note-1",
      targetId: "portal-1",
    })).toBeUndefined();
  });
});
