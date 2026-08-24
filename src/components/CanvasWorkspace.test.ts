import { describe, expect, it } from "vitest";
import type { Node as ReactFlowNode } from "@xyflow/react";
import {
  CANVAS_GRID_SPACING,
  canDuplicateCanvasNode,
  createShapeCanvasNode,
  createTextCanvasNode,
  duplicateCanvasNode,
  mergeTerminalScrollbackMetadata,
  snapCanvasPosition,
  validatedCanvasDrawings,
} from "./CanvasWorkspace";
import type { TerminalContent } from "../model/workspace";

function node(type: string): ReactFlowNode {
  return {
    id: "source-node",
    type,
    position: { x: 11, y: 23 },
    data: {
      contentVariant: type,
      content: type === "stickyNote"
        ? { text: "copy me", fileName: "original.md", storageMode: { custom: { _0: "original.md" } } }
        : { points: [[0, 0], [8, 8]] },
    },
  };
}

describe("CanvasWorkspace grid and duplication helpers", () => {
  it("snaps only when enabled and preserves unsnapped positions otherwise", () => {
    expect(CANVAS_GRID_SPACING).toBe(24);
    expect(snapCanvasPosition({ x: 15, y: 25 }, true, CANVAS_GRID_SPACING)).toEqual({ x: 24, y: 24 });
    expect(snapCanvasPosition({ x: 15, y: 25 }, false, CANVAS_GRID_SPACING)).toEqual({ x: 15, y: 25 });
  });

  it("duplicates notes/decorations with a new node and independent note storage", () => {
    const copy = duplicateCanvasNode(node("stickyNote"), { x: 32, y: 48 }, "copy-node");
    expect(copy.id).toBe("copy-node");
    expect(copy.position).toEqual({ x: 32, y: 48 });
    expect(copy.data.contentVariant).toBe("stickyNote");
    expect((copy.data.content as Record<string, unknown>).fileName).toBe("Note-copy-node.md");
    expect((copy.data.content as Record<string, unknown>).storageMode).toEqual({ managed: {} });
  });

  it("never duplicates a live terminal session", () => {
    expect(canDuplicateCanvasNode({ type: "text" })).toBe(true);
    expect(canDuplicateCanvasNode({ type: "freehand" })).toBe(true);
    expect(canDuplicateCanvasNode({ type: "terminal" })).toBe(false);
  });

  it("keeps drawings as an overlay payload and creates v2 text/shape nodes", () => {
    const drawings = validatedCanvasDrawings([{
      id: "drawing-1",
      points: [[10, 20], [30, 40]],
      color: "#f97316",
      lineWidth: 3,
      createdAt: "2026-01-01T00:00:00Z",
    }]);
    expect(drawings).toHaveLength(1);
    expect(drawings[0]).toMatchObject({ id: "drawing-1", color: "#f97316", lineWidth: 3 });
    expect(drawings[0]).not.toHaveProperty("type");

    const text = createTextCanvasNode({ x: 0, y: 0 }, "text-node");
    const shape = createShapeCanvasNode({ x: 24, y: 24 }, "shape-node");
    expect(text).toMatchObject({ id: "text-node", type: "text", data: { contentVariant: "text" } });
    expect((text.data.content as Record<string, unknown>).text).toBe("Novo texto");
    expect(shape).toMatchObject({ id: "shape-node", type: "shape", data: { contentVariant: "shape" } });
    expect((shape.data.content as Record<string, unknown>).shapeType).toBe("rect");
  });

  it("merges only changed scrollback metadata and preserves terminal fields", () => {
    const current: TerminalContent = {
      agentType: "test",
      command: "run",
      name: "Terminal",
      icon: "terminal",
      color: "#fff",
      id: "terminal-id",
      shellPath: "powershell.exe",
      workingDirectory: "C:\\",
      status: "running",
      isManager: false,
      monitorWithOmbro: false,
      autoScrollLocked: false,
      shortcutMode: { kind: "default" },
      scrollbackFile: "old.log",
      scrollbackLineCount: 4,
      args: ["--safe"],
    };
    const same = mergeTerminalScrollbackMetadata(current, {
      scrollbackFile: "old.log",
      scrollbackLineCount: 4,
    });
    expect(same.changed).toBe(false);
    expect(same.content).toBe(current);

    const changed = mergeTerminalScrollbackMetadata(current, {
      scrollbackFile: "new.log",
      scrollbackLineCount: 9,
    });
    expect(changed.changed).toBe(true);
    expect(changed.content).toMatchObject({
      id: "terminal-id",
      command: "run",
      args: ["--safe"],
      scrollbackFile: "new.log",
      scrollbackLineCount: 9,
    });
  });
});
