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
  });
});

describe("Freehand stroke calculations and background target safety", () => {
  it("calculates stroke bounding box, dimensions and normalized relative points", () => {
    const rawPoints = [{ x: 100, y: 100 }, { x: 300, y: 200 }];
    const strokeWidth = 4;
    const result = calculateFreehandStrokeFrame(rawPoints, strokeWidth);
    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.position.x).toBeLessThan(100);
    expect(result.position.y).toBeLessThan(100);
    expect(result.dimensions.width).toBeGreaterThan(200);
    expect(result.dimensions.height).toBeGreaterThan(100);

    expect(result.normalizedPoints).toHaveLength(2);
    expect(result.normalizedPoints[0].x).toBeGreaterThanOrEqual(0);
    expect(result.normalizedPoints[0].x).toBeLessThanOrEqual(0.5);
    expect(result.normalizedPoints[1].x).toBeGreaterThanOrEqual(0.5);
    expect(result.normalizedPoints[1].x).toBeLessThanOrEqual(1.0);
  });

  it("creates a freehand node with v2 content and schema v2 serialization wrapper", () => {
    const points = [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.9 }];
    const node = createFreehandCanvasNode(
      { x: 50, y: 50 },
      { width: 200, height: 150 },
      { points, freehandType: "pen", id: "freehand-1" },
    );
    expect(node.id).toBe("freehand-1");
    expect(node.type).toBe("freehand");
    expect(node.data.contentVariant).toBe("freehand");
    const content = node.data.content as FreehandContent;
    expect(content.freehandType).toBe("pen");
    expect(content.strokeColor).toBe("#f97316");

    const canvasNode = reactFlowNodeToCanvasNode(node);
    expect(canvasNode.content).toEqual({ freehand: { _0: content } });
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
