import { describe, expect, it } from "vitest";
import type { Node as ReactFlowNode } from "@xyflow/react";
import {
  CANVAS_GRID_SPACING,
  calculateFreehandStrokeFrame,
  canDuplicateCanvasNode,
  createFreehandCanvasNode,
  createShapeCanvasNode,
  createTextCanvasNode,
  duplicateCanvasNode,
  isCanvasBackgroundTarget,
  mergeTerminalScrollbackMetadata,
  reduceCanvasEscapeKey,
  snapCanvasPosition,
  validatedCanvasDrawings,
} from "./CanvasWorkspace";
import type { FreehandContent, TerminalContent } from "../model/workspace";
import { reactFlowNodeToCanvasNode } from "../store/workspaceStore";

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

    const withSession = mergeTerminalScrollbackMetadata(current, {
      agentSession: {
        provider: "codex",
        sessionId: "session-123",
        capturedAt: "1787940000000",
      },
    });
    expect(withSession.changed).toBe(true);
    expect(withSession.content.agentSession?.sessionId).toBe("session-123");
  });
});

describe("Freehand stroke calculations and background target safety", () => {
  it("calculates macOS parity stroke frame with fixed padding 8 and exact normalized points", () => {
    const rawPoints = [{ x: 100, y: 100 }, { x: 200, y: 200 }];
    const result = calculateFreehandStrokeFrame(rawPoints, 3);
    expect(result).not.toBeNull();
    if (!result) return;

    // macOS fixed padding = 8 -> posX = 92, posY = 92, width = 116, height = 116
    expect(result.position).toEqual({ x: 92, y: 92 });
    expect(result.dimensions).toEqual({ width: 116, height: 116 });

    // Normalized: (100 - 92)/116 = 0.06897, (200 - 92)/116 = 0.93103
    expect(result.normalizedPoints).toHaveLength(2);
    expect(result.normalizedPoints[0]).toEqual({ x: 0.06897, y: 0.06897 });
    expect(result.normalizedPoints[1]).toEqual({ x: 0.93103, y: 0.93103 });
  });

  it("creates freehand pen and highlighter nodes matching macOS default content schema", () => {
    const points = [{ x: 0.06897, y: 0.06897 }, { x: 0.93103, y: 0.93103 }];

    // Pen defaults: pen=3, opacity=1, color="blue"
    const penNode = createFreehandCanvasNode(
      { x: 92, y: 92 },
      { width: 116, height: 116 },
      { points, freehandType: "pen", id: "freehand-pen" },
    );
    expect(penNode.id).toBe("freehand-pen");
    expect(penNode.type).toBe("freehand");
    expect(penNode.data.contentVariant).toBe("freehand");
    const penContent = penNode.data.content as FreehandContent;
    expect(penContent).toEqual({
      freehandType: "pen",
      points,
      strokeColor: "blue",
      strokeWidth: 3,
      opacity: 1,
      rotation: 0,
    });

    const penCanvasNode = reactFlowNodeToCanvasNode(penNode);
    expect(penCanvasNode.content).toEqual({ freehand: { _0: penContent } });

    // Highlighter defaults: highlighter=12, opacity=0.4, color="yellow"
    const highlighterNode = createFreehandCanvasNode(
      { x: 92, y: 92 },
      { width: 116, height: 116 },
      { points, freehandType: "highlighter", id: "freehand-highlighter" },
    );
    const highlighterContent = highlighterNode.data.content as FreehandContent;
    expect(highlighterContent).toEqual({
      freehandType: "highlighter",
      points,
      strokeColor: "yellow",
      strokeWidth: 12,
      opacity: 0.4,
      rotation: 0,
    });
  });

  it("prevents starting drawing on controls, nodes, inputs and buttons", () => {
    const mockElement = (selectors: string[]) => ({
      closest: (sel: string) => selectors.includes(sel),
    });

    expect(isCanvasBackgroundTarget(mockElement([]))).toBe(true);
    expect(isCanvasBackgroundTarget(mockElement([".react-flow__node"]))).toBe(false);
    expect(isCanvasBackgroundTarget(mockElement([".canvas-toolbar"]))).toBe(false);
    expect(isCanvasBackgroundTarget(mockElement(["button"]))).toBe(false);
    expect(isCanvasBackgroundTarget(mockElement(["input"]))).toBe(false);
    expect(isCanvasBackgroundTarget(null)).toBe(false);
  });

  it("handles Escape key transitions: cancels active drawing stroke and resets active tool", () => {
    // Case 1: Escape while actively drawing -> cancels stroke and clears points
    const activeDrawingState = {
      activeTool: "pen" as const,
      isDrawing: true,
      drawingPoints: [{ x: 10, y: 20 }, { x: 30, y: 40 }],
    };
    const cancelResult = reduceCanvasEscapeKey(activeDrawingState);
    expect(cancelResult.handled).toBe(true);
    expect(cancelResult.cancelledDrawing).toBe(true);
    expect(cancelResult.resettedTool).toBe(false);
    expect(cancelResult.nextState.isDrawing).toBe(false);
    expect(cancelResult.nextState.drawingPoints).toEqual([]);
    expect(cancelResult.nextState.activeTool).toBe("pen");

    // Case 2: Escape while pen/highlighter tool is selected (not drawing) -> resets tool to select
    const toolSelectedState = {
      activeTool: "highlighter" as const,
      isDrawing: false,
      drawingPoints: [],
    };
    const resetResult = reduceCanvasEscapeKey(toolSelectedState);
    expect(resetResult.handled).toBe(true);
    expect(resetResult.cancelledDrawing).toBe(false);
    expect(resetResult.resettedTool).toBe(true);
    expect(resetResult.nextState.activeTool).toBe("select");

    // Case 3: Escape while in default select tool -> ignored
    const defaultState = {
      activeTool: "select" as const,
      isDrawing: false,
      drawingPoints: [],
    };
    const defaultResult = reduceCanvasEscapeKey(defaultState);
    expect(defaultResult.handled).toBe(false);
    expect(defaultResult.cancelledDrawing).toBe(false);
    expect(defaultResult.resettedTool).toBe(false);
  });
});
