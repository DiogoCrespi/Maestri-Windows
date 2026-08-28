import { describe, expect, it, vi } from "vitest";
import type { Edge as ReactFlowEdge, Node as ReactFlowNode } from "@xyflow/react";
import {
  AccessGraphSynchronizer,
  buildAccessGraphSnapshot,
  buildGraphIdentityMap,
  deterministicLegacyGraphId,
} from "./accessGraphSync";

const terminalUuid = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";

function terminal(nodeId: string, contentId: string, name = "Manager"): ReactFlowNode {
  return {
    id: nodeId,
    type: "terminal",
    position: { x: 0, y: 0 },
    data: {
      content: { id: contentId, name, isManager: true },
      contentVariant: "terminal",
    },
  };
}

function edge(source: string, target: string): ReactFlowEdge {
  return { id: `${source}-${target}`, source, target, type: "default" };
}

describe("access graph identity and synchronization", () => {
  it("maps a ReactFlow node ID separately from content.id and normalizes UUID case", () => {
    const nodes = [terminal("react-node-1", terminalUuid)];
    const map = buildGraphIdentityMap(nodes);
    const snapshot = buildAccessGraphSnapshot(nodes, [edge("react-node-1", "REACT-NODE-1")]);

    expect(snapshot.nodes[0]?.id).toBe(terminalUuid.toLowerCase());
    expect(snapshot.nodes[0]?.aliases).toEqual(["react-node-1", terminalUuid]);
    expect(map.resolveReactFlowNodeId(terminalUuid.toLowerCase())).toBe("react-node-1");
    expect(map.resolveReactFlowNodeId(terminalUuid.toLowerCase())).toBe(map.resolveReactFlowNodeId(terminalUuid));
    expect(snapshot.connections).toEqual([{ a: terminalUuid.toLowerCase(), b: terminalUuid.toLowerCase() }]);
  });

  it("migrates opaque legacy IDs deterministically without changing workspace node IDs", () => {
    const first = terminal("rf-opaque-node", "legacy-terminal-7");
    const second = terminal("rf-opaque-node", "legacy-terminal-7");
    const firstId = buildGraphIdentityMap([first]).identities[0]?.graphId;
    const secondId = buildGraphIdentityMap([second]).identities[0]?.graphId;

    expect(firstId).toBe(secondId);
    expect(firstId).toBe(deterministicLegacyGraphId("legacy-terminal-7"));
    expect(firstId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(first.id).toBe("rf-opaque-node");
  });

  it("resolves graphId aliases and maps connections to canonical IDs", () => {
    const nodes = [
      terminal("rf-a", "content-a"),
      {
        ...terminal("rf-b", "content-b", "Worker"),
        data: { content: { id: "content-b", graphId: terminalUuid }, contentVariant: "terminal" },
      },
    ];
    const map = buildGraphIdentityMap(nodes);
    const snapshot = buildAccessGraphSnapshot(nodes, [edge("RF-A", "rf-b")]);

    expect(map.resolveReactFlowNodeId(terminalUuid.toLowerCase())).toBe("rf-b");
    expect(snapshot.connections).toEqual([{
      a: deterministicLegacyGraphId("content-a"),
      b: terminalUuid.toLowerCase(),
    }]);
  });

  it("publishes a UUID-shaped ReactFlow ID as an alias of the content UUID", () => {
    const reactFlowUuid = "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB";
    const nodes = [terminal(reactFlowUuid, terminalUuid, "Worker")];
    const snapshot = buildAccessGraphSnapshot(nodes, []);

    expect(snapshot.nodes).toEqual([{
      id: terminalUuid.toLowerCase(),
      name: "Worker",
      aliases: [reactFlowUuid, terminalUuid],
      nodeType: "terminal",
      isManager: true,
    }]);
  });

  it("does not let a colliding content alias hijack a ReactFlow edge endpoint", () => {
    const nodes = [
      terminal("rf-a", "rf-b", "First"),
      terminal("rf-b", "content-b", "Second"),
    ];
    const map = buildGraphIdentityMap(nodes);
    const snapshot = buildAccessGraphSnapshot(nodes, [edge("rf-a", "rf-b")]);

    expect(map.resolveGraphId("rf-b")).toBe(deterministicLegacyGraphId("content-b"));
    expect(snapshot.connections).toEqual([{
      a: deterministicLegacyGraphId("rf-b"),
      b: deterministicLegacyGraphId("content-b"),
    }]);
  });

  it("ignores out-of-order responses and only exposes the latest revision", async () => {
    const pending: Array<{ resolve: (value: number) => void; reject: (reason: unknown) => void }> = [];
    const states: Array<{ phase: string; revision: number; message?: string }> = [];
    const replace = vi.fn(() => new Promise<number>((resolve, reject) => pending.push({ resolve, reject })));
    const sync = new AccessGraphSynchronizer(replace, (state) => states.push(state));
    const first = { nodes: [], connections: [] };
    const second = { nodes: [{ id: terminalUuid.toLowerCase(), name: "new" }], connections: [] };

    expect(sync.enqueue(first)).toBe(1);
    expect(sync.enqueue(second)).toBe(2);
    pending[1]?.resolve(22);
    await Promise.resolve();
    pending[0]?.reject(new Error("stale failure"));
    await Promise.resolve();

    expect(states.at(-1)).toEqual({ phase: "synced", revision: 2, result: 22 });
    expect(states.some((state) => state.phase === "error")).toBe(false);
    expect(replace).toHaveBeenCalledTimes(2);
  });

  it("keeps a latest workspace snapshot recoverable after an error", async () => {
    let rejectFirst: ((reason: unknown) => void) | undefined;
    const states: Array<{ phase: string; revision: number; message?: string }> = [];
    const replace = vi.fn()
      .mockImplementationOnce(() => new Promise<number>((_resolve, reject) => { rejectFirst = reject; }))
      .mockResolvedValueOnce(7);
    const sync = new AccessGraphSynchronizer(replace, (state) => states.push(state));
    const snapshot = { nodes: [], connections: [] };

    sync.enqueue(snapshot);
    rejectFirst?.(new Error("temporary graph failure"));
    await Promise.resolve();
    expect(states.at(-1)).toMatchObject({ phase: "error", revision: 1, message: "temporary graph failure" });

    expect(sync.retry()).toBe(2);
    await Promise.resolve();
    expect(states.at(-1)).toEqual({ phase: "synced", revision: 2, result: 7 });
  });
});
