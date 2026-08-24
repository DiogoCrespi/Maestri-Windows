import { describe, expect, it, vi } from "vitest";
import {
  buildRecruitedTerminal,
  classifyMaestroConnection,
  deriveMaestroAckContext,
  MaestroRequestTracker,
  registerMaestroListener,
  withMaestroAckContext,
} from "./useMaestroController";
import { normalizeMaestroConnectPayload } from "../lib/maestroContract";

const manager = {
  id: "manager-1",
  type: "terminal",
  position: { x: 10, y: 20 },
  style: { width: 450, height: 320 },
  data: { content: { shellPath: "powershell.exe", workingDirectory: "C:\\" } },
};

const recruit = {
  requestId: "7c1e7e5f-9ad4-4fa7-9e3f-9d1a6f20d2c4",
  sourceTerminalId: manager.id,
  name: "Worker",
  agentType: "claude_code",
  command: "claude --model sonnet",
  role: "builder",
  shellPath: "pwsh.exe",
  workingDirectory: "C:\\repo",
};

describe("useMaestroController pure invariants", () => {
  it("uses the same UUID for a recruited node and its terminal content", () => {
    const { node, edge } = buildRecruitedTerminal(recruit, manager, () => "worker-uuid");
    expect(node.id).toBe("worker-uuid");
    expect((node.data.content as { id: string }).id).toBe(node.id);
    expect(edge.source).toBe(manager.id);
    expect(edge.target).toBe(node.id);
    expect(edge.data?.connectionType).toBe("terminal");
  });

  it("maps recruit metadata to terminal content without confusing shellPath and command", () => {
    const { node } = buildRecruitedTerminal(recruit, manager, () => "worker-uuid");
    const content = node.data.content as Record<string, unknown>;
    expect(content).toMatchObject({
      name: "Worker",
      assignedRoleId: "builder",
      shellPath: "pwsh.exe",
      workingDirectory: "C:\\repo",
      command: "claude --model sonnet",
    });
    expect(content.command).not.toBe(content.shellPath);
  });

  it("does not synthesize an initial command from agentType or shellPath", () => {
    const { node } = buildRecruitedTerminal({
      ...recruit,
      command: undefined,
      agentType: "claude_code",
      shellPath: "powershell.exe",
    }, manager, () => "worker-uuid");
    const content = node.data.content as Record<string, unknown>;
    expect(content.command).toBe("");
    expect(content.command).not.toBe(content.shellPath);
  });

  it("uses the canonical workspace connection classification", () => {
    expect(classifyMaestroConnection("terminal", "terminal")).toBe("terminal");
    expect(classifyMaestroConnection("terminal", "stickyNote")).toBe("terminal-note");
    expect(classifyMaestroConnection("terminal", "portal")).toBe("terminal-portal");
    expect(classifyMaestroConnection("terminal", "fileTree")).toBeNull();
  });

  it("keeps the Manager actor independent from arbitrary connection endpoints", () => {
    const payload = normalizeMaestroConnectPayload({
      requestId: recruit.requestId,
      actorTerminalId: manager.id,
      sourceId: "note-1",
      targetId: "portal-1",
    });
    expect(payload.actorTerminalId).toBe(manager.id);
    expect(payload.sourceId).toBe("note-1");
    expect(payload.targetId).toBe("portal-1");
  });

  it("derives strict ACK context from each received command", () => {
    expect(deriveMaestroAckContext("recruit", recruit)).toEqual({
      actorTerminalId: "manager-1",
    });
    expect(deriveMaestroAckContext("dismiss", {
      requestId: recruit.requestId,
      sourceTerminalId: "manager-1",
      targetTerminalId: "worker-1",
    })).toEqual({
      actorTerminalId: "manager-1",
      targetId: "worker-1",
    });
    expect(deriveMaestroAckContext("role", {
      requestId: recruit.requestId,
      sourceTerminalId: "manager-1",
      targetTerminalId: "worker-1",
      role: "reviewer",
    })).toEqual({
      actorTerminalId: "manager-1",
      targetId: "worker-1",
    });
    expect(deriveMaestroAckContext("connect", {
      requestId: recruit.requestId,
      actorTerminalId: "manager-1",
      sourceId: "note-1",
      targetId: "portal-1",
    })).toEqual({
      actorTerminalId: "manager-1",
      sourceId: "note-1",
      targetId: "portal-1",
    });
  });

  it("overwrites result endpoints with command-derived strict context", () => {
    expect(withMaestroAckContext({
      requestId: recruit.requestId,
      action: "dismiss",
      success: true,
      targetId: "arbitrary-target",
    }, {
      actorTerminalId: "manager-1",
      targetId: "worker-1",
    })).toMatchObject({
      actorTerminalId: "manager-1",
      targetId: "worker-1",
    });
  });

  it("replays a completed result and suppresses concurrent duplicates", () => {
    const tracker = new MaestroRequestTracker();
    const result = { requestId: recruit.requestId, action: "recruit" as const, success: true, targetId: "worker-1" };
    expect(tracker.claim(recruit.requestId).accepted).toBe(true);
    expect(tracker.claim(recruit.requestId).accepted).toBe(false);
    tracker.complete(result);
    expect(tracker.claim(recruit.requestId)).toEqual({ accepted: false, replay: result });
  });

  it("unlistens when registration resolves after cleanup", async () => {
    let resolveSubscription!: (unlisten: () => void) => void;
    const subscription = new Promise<() => void>((resolve) => { resolveSubscription = resolve; });
    const unlisten = vi.fn();
    const addUnlisten = vi.fn();
    let mounted = true;
    const registering = registerMaestroListener(
      async () => subscription,
      "maestro://recruit",
      () => undefined,
      () => mounted,
      addUnlisten,
    );
    mounted = false;
    resolveSubscription(unlisten);
    await registering;
    expect(addUnlisten).not.toHaveBeenCalled();
    expect(unlisten).toHaveBeenCalledOnce();
  });
});
