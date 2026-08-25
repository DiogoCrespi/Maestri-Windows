import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow, Background, Controls, MiniMap, addEdge, applyEdgeChanges, applyNodeChanges,
  type Connection, BackgroundVariant, useReactFlow, ReactFlowProvider, type Node as ReactFlowNode,
  type OnNodeDrag, ViewportPortal,
} from "@xyflow/react";
import { TerminalNode } from "./TerminalNode";
import { NoteNode } from "./NoteNode";
import { FileTreeNode } from "./FileTreeNode";
import type { FileEntryPayload } from "./FileTreeNode";
import { PortalNode } from "./PortalNode";
import { DecorativeNode, catmullRomPathSvg } from "./DecorativeNode";
import { TerminalSettings, type TerminalSettingsValue } from "./TerminalSettings";
import {
  applyTerminalSettings,
  terminalContentFromSettings,
  terminalSettingsFromContent,
} from "./terminalContract";
import type {
  Drawing,
  FileTreeContent,
  FreehandContent,
  PortalContent,
  ShapeContent,
  StickyNoteContent,
  TerminalContent,
  TextContent,
} from "../model/workspace";
import { desktopBridge } from "../lib/desktopBridge";
import { classifyConnectionType, useWorkspaceStore } from "../store/workspaceStore";
import { resolveWorkspaceWorkingDirectory, workspaceFallbackDirectory } from "../lib/workingDirectory";

import { useMaestroController } from "../hooks/useMaestroController";

import { PreferencesPanel } from "./PreferencesPanel";
import { RoutinesPanel, type RoutineTerminalOption } from "./RoutinesPanel";
import { routinesAdapter } from "../bridge/routines";
import {
  AccessGraphSynchronizer,
  buildAccessGraphSnapshot,
  type AccessGraphSyncState,
} from "../lib/accessGraphSync";

const nodeTypes = {
  terminal: TerminalNode,
  stickyNote: NoteNode,
  fileTree: FileTreeNode,
  portal: PortalNode,
  text: DecorativeNode,
  shape: DecorativeNode,
  stroke: DecorativeNode,
  freehand: DecorativeNode,
  drawing: DecorativeNode,
  decorative: DecorativeNode,
};

const DECORATIVE_TYPES = new Set(["text", "shape", "stroke", "freehand", "drawing"]);
export const CANVAS_GRID_SPACING = 24;
const MAX_OVERLAY_DRAWINGS = 2048;
const MAX_OVERLAY_POINTS = 8192;
const MAX_DRAWING_COORDINATE = 1_000_000;

export interface ValidatedCanvasDrawing {
  id: string;
  points: Array<{ x: number; y: number }>;
  color: string;
  lineWidth: number;
}

function safeDrawingColor(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) return null;
  return /^[#a-zA-Z0-9(),.%\s-]+$/.test(value) ? value : null;
}

export function validateCanvasDrawing(value: unknown): ValidatedCanvasDrawing | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const drawing = value as Partial<Drawing>;
  if (typeof drawing.id !== "string" || !drawing.id.trim()) return null;
  if (!Array.isArray(drawing.points) || drawing.points.length < 2) return null;
  const points = drawing.points.slice(0, MAX_OVERLAY_POINTS).flatMap((point) => {
    if (!Array.isArray(point) || point.length < 2) return [];
    const x = point[0];
    const y = point[1];
    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) return [];
    if (Math.abs(x) > MAX_DRAWING_COORDINATE || Math.abs(y) > MAX_DRAWING_COORDINATE) return [];
    return [{ x, y }];
  });
  const color = safeDrawingColor(drawing.color);
  const lineWidth = typeof drawing.lineWidth === "number" && Number.isFinite(drawing.lineWidth)
    ? Math.min(64, Math.max(0.5, drawing.lineWidth))
    : null;
  if (points.length < 2 || !color || lineWidth === null) return null;
  return { id: drawing.id, points, color, lineWidth };
}

export function validatedCanvasDrawings(drawings: readonly unknown[]): ValidatedCanvasDrawing[] {
  return drawings.slice(0, MAX_OVERLAY_DRAWINGS).flatMap((drawing) => {
    const validated = validateCanvasDrawing(drawing);
    return validated ? [validated] : [];
  });
}

export function createTextCanvasNode(
  position: { x: number; y: number },
  id: string = crypto.randomUUID(),
): ReactFlowNode {
  const content: TextContent = {
    text: "Novo texto",
    fontSize: 18,
    fontWeight: "400",
    color: "#f4f4f5",
    alignment: "left",
    fontFamily: "inherit",
  };
  return {
    id,
    type: "text",
    position,
    style: { width: 280, height: 140 },
    data: { content, contentVariant: "text" },
  };
}

export function createShapeCanvasNode(
  position: { x: number; y: number },
  id: string = crypto.randomUUID(),
): ReactFlowNode {
  const content: ShapeContent = {
    shapeType: "rect",
    fillColor: "#1e3a8a",
    strokeColor: "#60a5fa",
    strokeWidth: 2,
    strokeStyle: "solid",
    fillStyle: "solid",
    text: "Nova forma",
    fontSize: 16,
    rotation: 0,
  };
  return {
    id,
    type: "shape",
    position,
    style: { width: 280, height: 180 },
    data: { content, contentVariant: "shape" },
  };
}

export interface CreateFreehandOptions {
  id?: string;
  points: Array<{ x: number; y: number }>;
  freehandType?: "pen" | "highlighter";
  strokeColor?: string;
  strokeWidth?: number;
  opacity?: number;
}

export function createFreehandCanvasNode(
  position: { x: number; y: number },
  dimensions: { width: number; height: number },
  options: {
    points: Array<{ x: number; y: number }>;
    freehandType?: "pen" | "highlighter";
    strokeColor?: string;
    strokeWidth?: number;
    opacity?: number;
    rotation?: number;
    id?: string;
  },
): ReactFlowNode {
  const freehandType = options.freehandType ?? "pen";
  const content: FreehandContent = {
    freehandType,
    points: options.points,
    strokeColor: options.strokeColor ?? (freehandType === "highlighter" ? "yellow" : "blue"),
    strokeWidth: options.strokeWidth ?? (freehandType === "highlighter" ? 12 : 3),
    opacity: options.opacity ?? (freehandType === "highlighter" ? 0.4 : 1),
    rotation: options.rotation ?? 0,
  };
  return {
    id: options.id ?? `freehand-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type: "freehand",
    position,
    style: { width: dimensions.width, height: dimensions.height },
    data: { content, contentVariant: "freehand" },
  };
}

export function calculateFreehandStrokeFrame(
  flowPoints: Array<{ x: number; y: number }>,
  _strokeWidth: number = 3,
): {
  position: { x: number; y: number };
  dimensions: { width: number; height: number };
  normalizedPoints: Array<{ x: number; y: number }>;
} | null {
  if (!Array.isArray(flowPoints) || flowPoints.length < 2) return null;
  const xs = flowPoints.map((p) => p.x);
  const ys = flowPoints.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  const padding = 8;
  const posX = minX - padding;
  const posY = minY - padding;
  const width = (maxX - minX) + padding * 2;
  const height = (maxY - minY) + padding * 2;

  const normalizedPoints = flowPoints.map((p) => ({
    x: width > 0 ? Number(((p.x - posX) / width).toFixed(5)) : 0.5,
    y: height > 0 ? Number(((p.y - posY) / height).toFixed(5)) : 0.5,
  }));

  return {
    position: { x: posX, y: posY },
    dimensions: { width, height },
    normalizedPoints,
  };
}

export function isCanvasBackgroundTarget(target: unknown): boolean {
  if (!target || typeof target !== "object" || !("closest" in target)) return false;
  const element = target as { closest: (selector: string) => unknown };
  if (
    element.closest(".react-flow__node") ||
    element.closest(".nodrag") ||
    element.closest(".nowheel") ||
    element.closest(".canvas-toolbar") ||
    element.closest(".react-flow__controls") ||
    element.closest(".react-flow__minimap") ||
    element.closest(".react-flow__handle") ||
    element.closest("button") ||
    element.closest("input") ||
    element.closest("textarea") ||
    element.closest("select")
  ) {
    return false;
  }
  return true;
}

export interface CanvasFreehandState {
  activeTool: "select" | "pen" | "highlighter";
  isDrawing: boolean;
  drawingPoints: Array<{ x: number; y: number }>;
}

export interface ReduceEscapeKeyResult {
  nextState: CanvasFreehandState;
  handled: boolean;
  cancelledDrawing: boolean;
  resettedTool: boolean;
}

export function reduceCanvasEscapeKey(state: CanvasFreehandState): ReduceEscapeKeyResult {
  if (state.isDrawing) {
    return {
      nextState: {
        ...state,
        isDrawing: false,
        drawingPoints: [],
      },
      handled: true,
      cancelledDrawing: true,
      resettedTool: false,
    };
  }
  if (state.activeTool !== "select") {
    return {
      nextState: {
        ...state,
        activeTool: "select",
      },
      handled: true,
      cancelledDrawing: false,
      resettedTool: true,
    };
  }
  return {
    nextState: state,
    handled: false,
    cancelledDrawing: false,
    resettedTool: false,
  };
}

export interface TerminalScrollbackMetadata {
  scrollbackFile?: string | null;
  scrollbackLineCount?: number;
}

export function mergeTerminalScrollbackMetadata(
  current: TerminalContent,
  update: TerminalScrollbackMetadata,
): { content: TerminalContent; changed: boolean } {
  const currentFile = current.scrollbackFile ?? null;
  const nextFile = update.scrollbackFile === undefined ? currentFile : update.scrollbackFile ?? null;
  const currentLineCount = current.scrollbackLineCount;
  const nextLineCount = typeof update.scrollbackLineCount === "number"
    && Number.isFinite(update.scrollbackLineCount)
    && update.scrollbackLineCount >= 0
    ? update.scrollbackLineCount
    : currentLineCount;
  if (currentFile === nextFile && currentLineCount === nextLineCount) {
    return { content: current, changed: false };
  }
  return {
    content: {
      ...current,
      scrollbackFile: nextFile,
      scrollbackLineCount: nextLineCount,
    },
    changed: true,
  };
}

export function snapCanvasPosition(
  position: { x: number; y: number },
  enabled: boolean,
  gridSize: number,
): { x: number; y: number } {
  if (!enabled || !Number.isFinite(gridSize) || gridSize <= 0) return position;
  return {
    x: Math.round(position.x / gridSize) * gridSize,
    y: Math.round(position.y / gridSize) * gridSize,
  };
}

export function canDuplicateCanvasNode(node: Pick<ReactFlowNode, "type">): boolean {
  return node.type === "stickyNote" || DECORATIVE_TYPES.has(node.type ?? "");
}

export function duplicateCanvasNode(
  node: ReactFlowNode,
  position: { x: number; y: number } = { ...node.position },
  id: string = crypto.randomUUID(),
): ReactFlowNode {
  const data = (node.data || {}) as Record<string, unknown>;
  const duplicateData: Record<string, unknown> = { ...data };
  const content = data.content;
  if (node.type === "stickyNote" && content && typeof content === "object" && !Array.isArray(content)) {
    // A duplicated note is independent from the original file. This avoids
    // two canvas nodes silently writing to the same note resource.
    duplicateData.content = {
      ...(content as Record<string, unknown>),
      fileName: `Note-${id}.md`,
      storageMode: { managed: {} },
    };
  }
  const now = new Date().toISOString();
  return {
    ...node,
    id,
    position,
    selected: true,
    data: { ...duplicateData, createdAt: now, lastModifiedAt: now },
  };
}

interface CanvasWorkspaceProps {
  workspacePath?: string;
}

function managedNotePath(workspacePath: string | undefined, fileName: string | null | undefined): string | null {
  if (!fileName || !workspacePath) return null;
  const normalized = workspacePath.replace(/\\/g, "/");
  const separator = normalized.lastIndexOf("/");
  const directory = separator >= 0 ? normalized.slice(0, separator) : ".";
  return `${directory}/notes/${fileName}`;
}

function CanvasDrawingOverlay({ drawings }: { drawings: readonly ValidatedCanvasDrawing[] }) {
  if (drawings.length === 0) return null;
  return (
    <ViewportPortal>
      <svg
        className="canvas-drawing-overlay"
        aria-hidden="true"
        width="100%"
        height="100%"
        style={{ position: "absolute", inset: 0, overflow: "visible", pointerEvents: "none" }}
      >
        {drawings.map((drawing) => (
          <polyline
            key={drawing.id}
            points={drawing.points.map((point) => `${point.x},${point.y}`).join(" ")}
            fill="none"
            stroke={drawing.color}
            strokeWidth={drawing.lineWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
            style={{ pointerEvents: "none" }}
          />
        ))}
      </svg>
    </ViewportPortal>
  );
}

function CanvasLiveStrokeOverlay({
  points,
  freehandType,
}: {
  points: ReadonlyArray<{ x: number; y: number }>;
  freehandType: "pen" | "highlighter";
}) {
  if (points.length < 2) return null;
  const strokeColor = freehandType === "highlighter" ? "#facc15" : "#f97316";
  const strokeWidth = freehandType === "highlighter" ? 20 : 4;
  const opacity = freehandType === "highlighter" ? 0.4 : 1;
  const pathData = catmullRomPathSvg(points as Array<{ x: number; y: number }>);
  return (
    <ViewportPortal>
      <svg
        className="canvas-live-stroke-overlay"
        aria-hidden="true"
        width="100%"
        height="100%"
        style={{ position: "absolute", inset: 0, overflow: "visible", pointerEvents: "none" }}
      >
        <path
          d={pathData}
          fill="none"
          stroke={strokeColor}
          strokeWidth={strokeWidth}
          opacity={opacity}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </ViewportPortal>
  );
}

const CanvasInner: React.FC<CanvasWorkspaceProps> = ({ workspacePath }) => {
  useMaestroController();
  const { setViewport, getZoom, setCenter, fitView, screenToFlowPosition } = useReactFlow();
  const nodes = useWorkspaceStore((state) => state.nodes);
  const edges = useWorkspaceStore((state) => state.edges);
  const currentDocument = useWorkspaceStore((state) => state.currentDocument);
  const setNodes = useWorkspaceStore((state) => state.setNodes);
  const setEdges = useWorkspaceStore((state) => state.setEdges);
  const addNode = useWorkspaceStore((state) => state.addNode);
  const updateViewport = useWorkspaceStore((state) => state.updateViewport);
  const hydratingViewport = useRef(false);
  const duplicateDragRef = useRef<{
    sourceId: string;
    duplicateId: string;
    originalPosition: { x: number; y: number };
  } | null>(null);
  const [activeTool, setActiveTool] = useState<"select" | "pen" | "highlighter">("select");
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawingPoints, setDrawingPoints] = useState<Array<{ x: number; y: number }>>([]);
  const pointerIdRef = useRef<number | null>(null);
  const capturedElementRef = useRef<HTMLElement | null>(null);

  const activeToolRef = useRef(activeTool);
  activeToolRef.current = activeTool;
  const isDrawingRef = useRef(isDrawing);
  isDrawingRef.current = isDrawing;

  const [snapToGrid, setSnapToGrid] = useState(true);
  const [gridSize, setGridSize] = useState(CANVAS_GRID_SPACING);
  const [showJumpBadges, setShowJumpBadges] = useState(false);
  const [showTerminalSettings, setShowTerminalSettings] = useState(false);
  const [showPreferencesPanel, setShowPreferencesPanel] = useState(false);
  const [showRoutinesPanel, setShowRoutinesPanel] = useState(false);
  const [terminalSettingsNodeId, setTerminalSettingsNodeId] = useState<string | null>(null);
  const [routinesWorkspaceError, setRoutinesWorkspaceError] = useState<string | null>(null);

  const releasePointerCapture = useCallback(() => {
    if (pointerIdRef.current !== null && capturedElementRef.current) {
      try {
        if (capturedElementRef.current.hasPointerCapture(pointerIdRef.current)) {
          capturedElementRef.current.releasePointerCapture(pointerIdRef.current);
        }
      } catch {
        // ignore
      }
    }
    pointerIdRef.current = null;
    capturedElementRef.current = null;
  }, []);

  const cancelFreehandDrawing = useCallback(() => {
    releasePointerCapture();
    setIsDrawing(false);
    setDrawingPoints([]);
  }, [releasePointerCapture]);

  const onPointerDownWorkspace = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (activeTool === "select") return;
    if (!isCanvasBackgroundTarget(event.target)) return;

    const element = event.currentTarget as HTMLElement;
    try {
      element.setPointerCapture(event.pointerId);
      pointerIdRef.current = event.pointerId;
      capturedElementRef.current = element;
    } catch {
      // ignore
    }

    const flowPos = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    setIsDrawing(true);
    setDrawingPoints([flowPos]);
  }, [activeTool, screenToFlowPosition]);

  const onPointerMoveWorkspace = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!isDrawing || (pointerIdRef.current !== null && event.pointerId !== pointerIdRef.current)) return;
    const flowPos = screenToFlowPosition({ x: event.clientX, y: event.clientY });

    setDrawingPoints((prev) => {
      if (prev.length === 0) return [flowPos];
      const last = prev[prev.length - 1];
      const distSq = (flowPos.x - last.x) ** 2 + (flowPos.y - last.y) ** 2;
      if (distSq < 16) return prev;
      if (prev.length >= 2000) return prev;
      return [...prev, flowPos];
    });
  }, [isDrawing, screenToFlowPosition]);

  const onPointerUpWorkspace = useCallback((_event: React.PointerEvent<HTMLDivElement>) => {
    if (!isDrawing) return;
    releasePointerCapture();

    if (drawingPoints.length >= 2) {
      const strokeWidth = activeTool === "highlighter" ? 12 : 3;
      const frameResult = calculateFreehandStrokeFrame(drawingPoints, strokeWidth);
      if (frameResult) {
        const newNode = createFreehandCanvasNode(
          frameResult.position,
          frameResult.dimensions,
          {
            points: frameResult.normalizedPoints,
            freehandType: activeTool === "highlighter" ? "highlighter" : "pen",
            strokeColor: activeTool === "highlighter" ? "yellow" : "blue",
            strokeWidth,
            opacity: activeTool === "highlighter" ? 0.4 : 1,
          },
        );
        addNode(newNode);
      }
    }

    setIsDrawing(false);
    setDrawingPoints([]);
  }, [activeTool, addNode, drawingPoints, isDrawing, releasePointerCapture]);

  const onPointerCancelWorkspace = useCallback((_event: React.PointerEvent<HTMLDivElement>) => {
    if (!isDrawing) return;
    cancelFreehandDrawing();
  }, [cancelFreehandDrawing, isDrawing]);
  const routinesWorkspacePath = workspacePath?.trim() || "";
  const workspaceDirectory = workspaceFallbackDirectory(
    currentDocument?.payload.workingDirectory,
    workspacePath,
  );
  const overlayDrawings = useMemo(
    () => validatedCanvasDrawings(currentDocument?.payload.drawings ?? []),
    [currentDocument?.payload.drawings],
  );
  const [accessGraphState, setAccessGraphState] = useState<AccessGraphSyncState>({ phase: "idle", revision: 0 });
  const accessGraphSync = useMemo(() => new AccessGraphSynchronizer(
    (graphNodes, graphConnections) => desktopBridge.replaceAccessGraph(graphNodes, graphConnections),
    setAccessGraphState,
  ), []);
  const selectedTerminal = useMemo(
    () => nodes.find((node) => node.type === "terminal" && node.selected),
    [nodes],
  );
  const routineTerminals = useMemo<RoutineTerminalOption[]>(() => nodes.flatMap((node) => {
    if (node.type !== "terminal") return [];
    const content = (node.data as { content?: TerminalContent }).content;
    if (!content?.id) return [];
    return [{ id: content.id, name: content.name || content.id }];
  }), [nodes]);

  // Activate workspace-scoped routines as soon as App confirms a path. The
  // panel is intentionally not required to be open for this bridge state to
  // follow workspace changes.
  useEffect(() => {
    if (!routinesWorkspacePath) {
      setRoutinesWorkspaceError(null);
      return;
    }

    let active = true;
    setRoutinesWorkspaceError(null);
    void routinesAdapter.setWorkspace(routinesWorkspacePath).catch((error: unknown) => {
      if (active) setRoutinesWorkspaceError(`Não foi possível ativar as rotinas: ${String(error)}`);
    });
    return () => {
      active = false;
    };
  }, [routinesWorkspacePath]);

  // Migrate legacy/default node directories after workspace hydration without
  // touching explicit absolute custom paths. The same resolver is also used
  // for the first render below, so PTY/FileTree never briefly start at C:\\.
  useEffect(() => {
    if (!currentDocument || nodes.length === 0) return;
    let changed = false;
    const normalizedNodes = nodes.map((node) => {
      const data = node.data as { content?: unknown; contentVariant?: string };
      if (node.type === "terminal" && data.content && typeof data.content === "object") {
        const content = data.content as TerminalContent;
        const workingDirectory = resolveWorkspaceWorkingDirectory(
          content.workingDirectory,
          workspaceDirectory,
        );
        if (workingDirectory !== content.workingDirectory) {
          changed = true;
          return { ...node, data: { ...node.data, content: { ...content, workingDirectory } } };
        }
      }
      if (node.type === "fileTree" && data.content && typeof data.content === "object") {
        const content = data.content as FileTreeContent;
        const rootPath = resolveWorkspaceWorkingDirectory(content.rootPath, workspaceDirectory);
        if (rootPath !== content.rootPath) {
          changed = true;
          return { ...node, data: { ...node.data, content: { ...content, rootPath } } };
        }
      }
      return node;
    });
    if (changed) setNodes(normalizedNodes, { dirty: false });
  }, [currentDocument, nodes, setNodes, workspaceDirectory]);

  const closeNode = useCallback((nodeId: string) => {
    setNodes(nodes.filter((node) => node.id !== nodeId));
    setEdges(edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId));
  }, [edges, nodes, setEdges, setNodes]);

  const updateDecorativeContent = useCallback((nodeId: string, content: Record<string, unknown>) => {
    setNodes(nodes.map((node) => node.id === nodeId
      ? { ...node, data: { ...node.data, content } }
      : node));
  }, [nodes, setNodes]);

  const updateTerminalScrollback = useCallback((nodeId: string, update: TerminalContent) => {
    const currentNodes = useWorkspaceStore.getState().nodes;
    const target = currentNodes.find((node) => node.id === nodeId && node.type === "terminal");
    if (!target) return;
    const currentContent = (target.data as { content?: TerminalContent }).content;
    if (!currentContent) return;
    const merged = mergeTerminalScrollbackMetadata(currentContent, update);
    if (!merged.changed) return;
    setNodes(currentNodes.map((node) => node.id === nodeId
      ? { ...node, data: { ...node.data, content: merged.content } }
      : node), { dirty: true });
  }, [setNodes]);

  const updateNote = useCallback((nodeId: string, text: string, title?: string) => {
    setNodes(nodes.map((node) => {
      if (node.id !== nodeId) return node;
      const data = node.data as { content?: StickyNoteContent & { title?: string; text?: string }; contentVariant?: string };
      if (!data.content || data.contentVariant !== "stickyNote") return node;
      return { ...node, data: { ...node.data, content: { ...data.content, title: title ?? data.content.title, text } } };
    }));
  }, [nodes, setNodes]);

  const openFileAsNote = useCallback((sourceNodeId: string, entry: FileEntryPayload) => {
    const existing = nodes.find((node) => {
      const data = node.data as { content?: StickyNoteContent; contentVariant?: string };
      return data.contentVariant === "stickyNote"
        && data.content?.storageMode && "custom" in data.content.storageMode
        && data.content.storageMode.custom._0 === entry.path;
    });
    if (existing) {
      setNodes(nodes.map((node) => ({ ...node, selected: node.id === existing.id })), { dirty: false });
      return;
    }
    const source = nodes.find((node) => node.id === sourceNodeId);
    const nodeId = crypto.randomUUID();
    const content: StickyNoteContent & { title: string; text: string } = {
      title: entry.name,
      text: "",
      fileName: entry.name,
      color: "#dbeafe",
      fontSize: 14,
      hasCustomName: true,
      isPreviewing: false,
      storageMode: { custom: { _0: entry.path } },
    };
    addNode({
      id: nodeId,
      type: "stickyNote",
      position: { x: (source?.position.x ?? 0) + 380, y: source?.position.y ?? 0 },
      style: { width: 360, height: 300 },
      dragHandle: ".drag-handle",
      data: { content, contentVariant: "stickyNote" },
    });
  }, [addNode, nodes, setNodes]);

  const updatePortalUrl = useCallback((nodeId: string, currentURL: string) => {
    setNodes(nodes.map((node) => {
      if (node.id !== nodeId) return node;
      const data = node.data as { content?: PortalContent; contentVariant?: string };
      if (!data.content || data.contentVariant !== "portal") return node;
      return {
        ...node,
        data: {
          ...node.data,
          content: {
            ...data.content,
            currentURL,
            source: currentURL ? { url: { _0: currentURL } } : { none: {} },
          },
        },
      };
    }));
  }, [nodes, setNodes]);

  const jumpMap = useMemo(() => {
    if (!showJumpBadges) return new Map<string, number>();
    const terminalNodes = nodes.filter((node) => node.type === "terminal")
      .sort((a, b) => a.position.x - b.position.x || a.position.y - b.position.y);
    return new Map(terminalNodes.slice(0, 9).map((node, index) => [node.id, index + 1]));
  }, [nodes, showJumpBadges]);

  const displayedNodes = useMemo(() => nodes.map((node) => {
    const data = node.data as { content?: StickyNoteContent; contentVariant?: string };
    const storageMode = data.content?.storageMode;
    const notePath = data.contentVariant === "stickyNote"
      ? (storageMode && "custom" in storageMode
          ? storageMode.custom._0
          : managedNotePath(workspacePath, data.content?.fileName))
      : null;
    const displayContent = node.type === "terminal" && data.content
      ? {
          ...(data.content as unknown as TerminalContent),
          workingDirectory: resolveWorkspaceWorkingDirectory(
            (data.content as unknown as TerminalContent).workingDirectory,
            workspaceDirectory,
          ),
        }
      : node.type === "fileTree" && data.content
        ? {
            ...(data.content as unknown as FileTreeContent),
            rootPath: resolveWorkspaceWorkingDirectory(
              (data.content as unknown as FileTreeContent).rootPath,
              workspaceDirectory,
            ),
          }
        : undefined;
    const sourceType = node.type ?? "";
    const renderType = Object.prototype.hasOwnProperty.call(nodeTypes, sourceType)
      ? sourceType
      : "decorative";
    const isDecorative = DECORATIVE_TYPES.has(sourceType) || renderType === "decorative";
    return {
      ...node,
      type: renderType,
      dragHandle: ".drag-handle",
      data: {
        ...node.data,
        ...(displayContent ? { content: displayContent } : {}),
        onClose: () => closeNode(node.id),
        jumpNumber: jumpMap.get(node.id),
        ...(node.type === "stickyNote" ? {
          content: { ...data.content, path: notePath },
          onChangeContent: (text: string, title?: string) => updateNote(node.id, text, title),
        } : {}),
        ...(node.type === "fileTree" ? {
          onFileSelect: (entry: FileEntryPayload) => openFileAsNote(node.id, entry),
        } : {}),
        ...(node.type === "portal" ? {
          onChangeURL: (url: string) => updatePortalUrl(node.id, url),
        } : {}),
        ...(isDecorative ? {
          onChangeContent: (content: Record<string, unknown>) => updateDecorativeContent(node.id, content),
        } : {}),
        ...(node.type === "terminal" ? {
          onChangeContent: (content: TerminalContent) => updateTerminalScrollback(node.id, content),
        } : {}),
      },
    };
  }), [closeNode, jumpMap, nodes, openFileAsNote, updateDecorativeContent, updateNote, updatePortalUrl, updateTerminalScrollback, workspaceDirectory, workspacePath]);

  const accessGraphSnapshot = useMemo(
    () => buildAccessGraphSnapshot(nodes, edges, workspacePath),
    [edges, nodes, workspacePath],
  );

  useEffect(() => {
    accessGraphSync.enqueue(accessGraphSnapshot);
  }, [accessGraphSnapshot, accessGraphSync]);

  useEffect(() => () => accessGraphSync.dispose(), [accessGraphSync]);

  const workspaceId = currentDocument?.payload.id;
  useEffect(() => {
    if (!currentDocument) return;
    hydratingViewport.current = true;
    const frame = window.requestAnimationFrame(async () => {
      if (nodes.length > 0) {
        const origin = currentDocument.payload.canvasOrigin;
        const zoom = Math.min(3, Math.max(0.1, currentDocument.payload.canvasZoom || 1));
        const xs = nodes.map((node) => node.position.x);
        const ys = nodes.map((node) => node.position.y);
        const originLooksRelevant = origin.x >= Math.min(...xs) - 2500 && origin.x <= Math.max(...xs) + 2500
          && origin.y >= Math.min(...ys) - 2500 && origin.y <= Math.max(...ys) + 2500;
        if (originLooksRelevant) {
          await setViewport({ x: -origin.x * zoom, y: -origin.y * zoom, zoom });
        } else {
          await fitView({ padding: 0.18, minZoom: 0.25, maxZoom: 1.2, duration: 250 });
        }
      } else {
        await setViewport({ x: 0, y: 0, zoom: 1 });
      }
      window.requestAnimationFrame(() => { hydratingViewport.current = false; });
    });
    return () => window.cancelAnimationFrame(frame);
  // Rehydrate once per loaded workspace; viewport changes update the document.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, fitView, setViewport]);

  const onConnect = useCallback((params: Connection) => {
    const source = nodes.find((node) => node.id === params.source);
    const target = nodes.find((node) => node.id === params.target);
    const connectionType = classifyConnectionType(source?.type, target?.type);
    if (!connectionType) return;
    const stroke = connectionType === "terminal" ? "#3b82f6"
      : connectionType === "terminal-note" ? "#eab308"
      : connectionType === "terminal-portal" ? "#8b5cf6"
      : connectionType === "note-note" ? "#f59e0b"
      : "#a855f7";
    setEdges(addEdge({
      ...params, id: crypto.randomUUID(),
      type: "smoothstep", animated: true,
      data: { connectionType, createdAt: new Date().toISOString(), ropePoints: [] },
      style: { stroke, strokeWidth: 2 },
    }, edges));
  }, [edges, nodes, setEdges]);

  const addTerminalNode = useCallback((settings?: TerminalSettingsValue) => {
    const nodeId = crypto.randomUUID();
    const center = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    const content = terminalContentFromSettings(
      nodeId,
      `Terminal ${nodes.filter((node) => node.type === "terminal").length + 1}`,
      settings,
      workspaceDirectory,
    );
    addNode({ id: nodeId, type: "terminal", position: { x: center.x - 225, y: center.y - 160 }, style: { width: 450, height: 320 }, dragHandle: ".drag-handle", data: { content, contentVariant: "terminal" } });
  }, [addNode, nodes, screenToFlowPosition, workspaceDirectory]);

  const editingTerminal = terminalSettingsNodeId
    ? nodes.find((node) => node.id === terminalSettingsNodeId && node.type === "terminal")
    : undefined;
  const editingTerminalContent = editingTerminal
    ? ((editingTerminal.data as { content?: TerminalContent }).content)
    : undefined;

  const openTerminalSettings = useCallback(() => {
    setTerminalSettingsNodeId(selectedTerminal?.id ?? null);
    setShowTerminalSettings(true);
  }, [selectedTerminal]);

  const applySettings = useCallback((settings: TerminalSettingsValue) => {
    if (!terminalSettingsNodeId || !editingTerminalContent) {
      addTerminalNode(settings);
    } else {
      setNodes(nodes.map((node) => node.id === terminalSettingsNodeId
        ? {
            ...node,
            data: {
              ...node.data,
              content: applyTerminalSettings(editingTerminalContent, settings, workspaceDirectory),
            },
          }
        : node), { dirty: true });
    }
    setShowTerminalSettings(false);
    setTerminalSettingsNodeId(null);
  }, [addTerminalNode, editingTerminalContent, nodes, setNodes, terminalSettingsNodeId, workspaceDirectory]);

  const addNoteNode = useCallback(() => {
    const nodeId = crypto.randomUUID();
    const center = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    const content: StickyNoteContent & { title: string; text: string } = {
      title: "Nova nota", text: "", fileName: `Note-${nodeId}.md`, color: "#fef08a", fontSize: 14, hasCustomName: true, isPreviewing: false, storageMode: { managed: {} },
    };
    addNode({ id: nodeId, type: "stickyNote", position: { x: center.x - 130, y: center.y - 110 }, style: { width: 260, height: 220 }, dragHandle: ".drag-handle", data: { content, contentVariant: "stickyNote" } });
  }, [addNode, screenToFlowPosition]);

  const addTextNode = useCallback(() => {
    const center = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    addNode(createTextCanvasNode({ x: center.x - 140, y: center.y - 70 }));
  }, [addNode, screenToFlowPosition]);

  const addShapeNode = useCallback(() => {
    const center = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    addNode(createShapeCanvasNode({ x: center.x - 140, y: center.y - 90 }));
  }, [addNode, screenToFlowPosition]);

  const addFileTreeNode = useCallback(() => {
    const center = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    const content: FileTreeContent = {
      name: "Arquivos",
      rootPath: workspaceDirectory,
      viewMode: "list",
    };
    addNode({
      id: crypto.randomUUID(), type: "fileTree", position: { x: center.x - 170, y: center.y - 210 },
      style: { width: 340, height: 420 }, dragHandle: ".drag-handle", data: { content, contentVariant: "fileTree" },
    });
  }, [addNode, screenToFlowPosition, workspaceDirectory]);

  const addPortalNode = useCallback(() => {
    const nodeId = crypto.randomUUID();
    const center = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    const currentURL = "https://example.com";
    const content: PortalContent = {
      id: crypto.randomUUID(),
      name: `Portal ${nodes.filter((node) => node.type === "portal").length + 1}`,
      currentURL,
      source: { url: { _0: currentURL } },
      status: "idle",
      chromeHidden: false,
      storageScope: "isolated",
    };
    addNode({
      id: nodeId, type: "portal", position: { x: center.x - 350, y: center.y - 250 },
      style: { width: 700, height: 500 }, dragHandle: ".drag-handle", data: { content, contentVariant: "portal" },
    });
  }, [addNode, nodes, screenToFlowPosition]);

  const duplicateSelectedNode = useCallback((): boolean => {
    const currentNodes = useWorkspaceStore.getState().nodes;
    const selected = currentNodes.find((node) => node.selected && canDuplicateCanvasNode(node));
    if (!selected) return false;
    const duplicate = duplicateCanvasNode(selected, {
      x: selected.position.x + gridSize * 2,
      y: selected.position.y + gridSize * 2,
    });
    setNodes([...currentNodes, duplicate], { dirty: true });
    return true;
  }, [gridSize, setNodes]);

  const onNodeDragStart = useCallback<OnNodeDrag>((event, node) => {
    if (!("altKey" in event) || !event.altKey || !canDuplicateCanvasNode(node)) return;
    const currentNodes = useWorkspaceStore.getState().nodes;
    const selectedCount = currentNodes.filter((candidate) => candidate.selected).length;
    if (selectedCount > 1) return;
    const source = currentNodes.find((candidate) => candidate.id === node.id);
    if (!source) return;
    const duplicate = duplicateCanvasNode(source, { ...source.position });
    duplicateDragRef.current = {
      sourceId: source.id,
      duplicateId: duplicate.id,
      originalPosition: { ...source.position },
    };
    setNodes([...currentNodes, duplicate], { dirty: true });
  }, [setNodes]);

  const onNodeDrag = useCallback<OnNodeDrag>((_event, node) => {
    const drag = duplicateDragRef.current;
    if (!drag || drag.sourceId !== node.id) return;
    const currentNodes = useWorkspaceStore.getState().nodes;
    setNodes(currentNodes.map((candidate) => {
      if (candidate.id === drag.sourceId) return { ...candidate, position: drag.originalPosition, selected: false };
      if (candidate.id === drag.duplicateId) return { ...candidate, position: node.position, selected: true };
      return candidate;
    }), { dirty: true });
  }, [setNodes]);

  const onNodeDragStop = useCallback<OnNodeDrag>((_event, node) => {
    const drag = duplicateDragRef.current;
    if (drag && drag.sourceId === node.id) {
      const currentNodes = useWorkspaceStore.getState().nodes;
      const finalPosition = snapCanvasPosition(node.position, snapToGrid, gridSize);
      setNodes(currentNodes.map((candidate) => {
        if (candidate.id === drag.sourceId) return { ...candidate, position: drag.originalPosition, selected: false };
        if (candidate.id === drag.duplicateId) return { ...candidate, position: finalPosition, selected: true };
        return candidate;
      }), { dirty: true });
      duplicateDragRef.current = null;
      return;
    }
    if (!snapToGrid) return;
    const snapped = snapCanvasPosition(node.position, true, gridSize);
    if (snapped.x === node.position.x && snapped.y === node.position.y) return;
    const currentNodes = useWorkspaceStore.getState().nodes;
    setNodes(currentNodes.map((candidate) => candidate.id === node.id
      ? { ...candidate, position: snapped }
      : candidate), { dirty: true });
  }, [gridSize, setNodes, snapToGrid]);

  useEffect(() => {
    const isEditing = () => {
      const element = document.activeElement;
      return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element?.classList.contains("xterm-helper-textarea");
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditing()) return;
      if (event.key === "Escape") {
        const currentCanvasState: CanvasFreehandState = {
          activeTool: activeToolRef.current,
          isDrawing: isDrawingRef.current,
          drawingPoints,
        };
        const escapeResult = reduceCanvasEscapeKey(currentCanvasState);
        if (escapeResult.handled) {
          event.preventDefault();
          if (escapeResult.cancelledDrawing) {
            cancelFreehandDrawing();
          } else if (escapeResult.resettedTool) {
            setActiveTool("select");
          }
        }
      }
      const modified = event.metaKey || event.ctrlKey;
      if (event.key === "Control" || event.key === "Meta") setShowJumpBadges(true);
      if (modified && event.key >= "1" && event.key <= "9") {
        const targetId = [...jumpMap].find(([, number]) => number === Number(event.key))?.[0];
        const target = nodes.find((node) => node.id === targetId);
        if (target) {
          event.preventDefault();
          const width = Number(target.width ?? target.style?.width ?? 450);
          const height = Number(target.height ?? target.style?.height ?? 320);
          void setCenter(target.position.x + width / 2, target.position.y + height / 2, { duration: 350 });
          setNodes(nodes.map((node) => ({ ...node, selected: node.id === targetId })), { dirty: false });
        }
      }
      if (modified && event.key.toLowerCase() === "w") {
        event.preventDefault();
        const removedIds = new Set(nodes.filter((node) => node.selected).map((node) => node.id));
        setNodes(nodes.filter((node) => !removedIds.has(node.id)));
        setEdges(edges.filter((edge) => !removedIds.has(edge.source) && !removedIds.has(edge.target)));
      }
      if (modified && event.key.toLowerCase() === "d") {
        if (duplicateSelectedNode()) event.preventDefault();
      }
      if (modified && ["+", "=", "-", "0"].includes(event.key)) {
        event.preventDefault();
        const zoom = event.key === "0" ? 1 : Math.min(3, Math.max(0.1, getZoom() + (event.key === "-" ? -0.1 : 0.1)));
        void setViewport({ x: 0, y: 0, zoom });
      }
    };
    const handleKeyUp = (event: KeyboardEvent) => { if (event.key === "Control" || event.key === "Meta") setShowJumpBadges(false); };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => { window.removeEventListener("keydown", handleKeyDown); window.removeEventListener("keyup", handleKeyUp); };
  }, [cancelFreehandDrawing, drawingPoints, duplicateSelectedNode, edges, getZoom, jumpMap, nodes, setCenter, setEdges, setNodes, setViewport]);

  return (
    <div
      style={{ width: "100vw", height: "100vh", position: "relative", backgroundColor: "#09090b", cursor: activeTool !== "select" ? "crosshair" : "default" }}
      onPointerDown={onPointerDownWorkspace}
      onPointerMove={onPointerMoveWorkspace}
      onPointerUp={onPointerUpWorkspace}
      onPointerCancel={onPointerCancelWorkspace}
    >
      <div
        className="canvas-toolbar nodrag nowheel"
        role="toolbar"
        aria-label="Ferramentas do Canvas"
      >
        <div className="canvas-toolbar-brand">
          <strong>Maestri Canvas</strong>
        </div>

        <div className="canvas-toolbar-group">
          <label className="canvas-toolbar-snap" title="Alinha posições dos nós ao grid">
            <input
              type="checkbox"
              checked={snapToGrid}
              onChange={(event) => setSnapToGrid(event.target.checked)}
            />
            <span>Snap</span>
          </label>
          <select
            className="canvas-toolbar-select"
            value={gridSize}
            onChange={(event) => setGridSize(Number(event.target.value))}
            aria-label="Tamanho do grid"
            title="Tamanho da grade do grid"
          >
            {[8, 16, 24, 32].map((size) => (
              <option key={size} value={size}>
                {size}px
              </option>
            ))}
          </select>
        </div>

        <div className="canvas-toolbar-divider" />

        {/* Dynamic Status Slot with Reserved Space to Prevent Layout Shift */}
        <div className="canvas-toolbar-status-slot">
          {accessGraphState.phase === "pending" && (
            <span className="canvas-status-badge pending" role="status" aria-live="polite">
              Sincronizando...
            </span>
          )}
          {accessGraphState.phase === "error" && (
            <span className="canvas-status-badge error" role="alert" title={accessGraphState.message}>
              Erro grafo
              <button
                type="button"
                className="canvas-status-retry-btn"
                onClick={() => accessGraphSync.retry()}
                title="Tentar sincronizar grafo novamente"
              >
                ↻
              </button>
            </span>
          )}
          {routinesWorkspaceError && (
            <span className="canvas-status-badge error" role="alert" title={routinesWorkspaceError}>
              Erro rotinas
            </span>
          )}
        </div>

        <div className="canvas-toolbar-divider" />

        <div className="canvas-toolbar-actions">
          <button
            type="button"
            className="canvas-action-btn icon-btn"
            onClick={() => addTerminalNode()}
            aria-label="Criar novo terminal"
            title="Novo terminal"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>
          </button>

          <button
            type="button"
            className={`canvas-action-btn icon-btn ${showTerminalSettings ? "active" : ""}`}
            onClick={() => {
              if (showTerminalSettings) {
                setShowTerminalSettings(false);
                setTerminalSettingsNodeId(null);
              } else {
                openTerminalSettings();
              }
            }}
            aria-label={editingTerminal || selectedTerminal ? "Editar configurações do terminal" : "Configurar terminal"}
            title={editingTerminal || selectedTerminal ? "Editar terminal" : "Configurar terminal"}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
          </button>

          <button
            type="button"
            className={`canvas-action-btn icon-btn ${showPreferencesPanel ? "active" : ""}`}
            onClick={() => setShowPreferencesPanel(true)}
            aria-label="Presets e roles"
            title="Presets e Roles"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>
          </button>

          <button
            type="button"
            className={`canvas-action-btn icon-btn ${showRoutinesPanel ? "active" : ""}`}
            onClick={() => setShowRoutinesPanel(true)}
            aria-label="Painel de Rotinas"
            title="Rotinas"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
          </button>

          <button
            type="button"
            className="canvas-action-btn icon-btn"
            onClick={addNoteNode}
            aria-label="Criar nova nota"
            title="Nova Nota"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>
          </button>

          <button
            type="button"
            className="canvas-action-btn icon-btn"
            onClick={addTextNode}
            aria-label="Criar nó de texto"
            title="Novo Texto"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="4 7 4 4 20 4 20 7"></polyline><line x1="9" y1="20" x2="15" y2="20"></line><line x1="12" y1="4" x2="12" y2="20"></line></svg>
          </button>

          <button
            type="button"
            className="canvas-action-btn icon-btn"
            onClick={addShapeNode}
            aria-label="Criar nó de forma geométrica"
            title="Nova Forma"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect></svg>
          </button>

          <button
            type="button"
            className="canvas-action-btn icon-btn"
            onClick={addFileTreeNode}
            aria-label="Criar nó da árvore de arquivos"
            title="Árvore de Arquivos"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
          </button>

          <button
            type="button"
            className="canvas-action-btn icon-btn"
            onClick={addPortalNode}
            aria-label="Criar nó de portal web"
            title="Novo Portal"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>
          </button>

          <button
            type="button"
            className={`canvas-action-btn icon-btn ${activeTool === "pen" ? "active" : ""}`}
            onClick={() => setActiveTool((prev) => (prev === "pen" ? "select" : "pen"))}
            aria-label="Ferramenta Caneta (Pen)"
            title="Desenhar com caneta"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>
          </button>

          <button
            type="button"
            className={`canvas-action-btn icon-btn ${activeTool === "highlighter" ? "active" : ""}`}
            onClick={() => setActiveTool((prev) => (prev === "highlighter" ? "select" : "highlighter"))}
            aria-label="Ferramenta Marca-texto (Highlighter)"
            title="Desenhar com marca-texto"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 11-6 6v3h3l6-6"></path><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"></path></svg>
          </button>
        </div>
      </div>
      <PreferencesPanel
        isOpen={showPreferencesPanel}
        onClose={() => setShowPreferencesPanel(false)}
      />
      {showRoutinesPanel && (
        <RoutinesPanel
          onClose={() => setShowRoutinesPanel(false)}
          workspacePath={routinesWorkspacePath || undefined}
          availableTerminals={routineTerminals}
        />
      )}
      {showTerminalSettings && (
        <div style={{ position: "absolute", top: 118, right: 18, zIndex: 120, pointerEvents: "auto" }}>
          <TerminalSettings
            key={editingTerminal?.id ?? "new-terminal"}
            initialValues={editingTerminalContent
              ? terminalSettingsFromContent(editingTerminalContent, workspaceDirectory)
              : { name: `Terminal ${nodes.filter((node) => node.type === "terminal").length + 1}`, workingDirectory: workspaceDirectory }}
            onApply={applySettings}
          />
        </div>
      )}
      <ReactFlow
        nodes={displayedNodes}
        edges={edges}
        nodeTypes={nodeTypes}
        snapToGrid={snapToGrid}
        snapGrid={[gridSize, gridSize]}
        onNodeDragStart={onNodeDragStart}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        onNodesChange={(changes) => {
          const changesWorkspace = changes.some((change) =>
            change.type === "add" || change.type === "remove" || change.type === "position"
            || (change.type === "dimensions" && change.resizing === true));
          setNodes(applyNodeChanges(changes, nodes), { dirty: changesWorkspace });
        }}
        onNodesDelete={(deletedNodes) => {
          const deletedIds = new Set(deletedNodes.map((node) => node.id));
          setEdges(edges.filter((edge) => !deletedIds.has(edge.source) && !deletedIds.has(edge.target)));
        }}
        onEdgesChange={(changes) => setEdges(applyEdgeChanges(changes, edges))}
        onConnect={onConnect}
        onMoveEnd={(_event, viewport) => {
          if (hydratingViewport.current) return;
          updateViewport({ x: -viewport.x / viewport.zoom, y: -viewport.y / viewport.zoom }, viewport.zoom);
        }}
        minZoom={0.1}
        maxZoom={3}
        colorMode="dark"
      >
        <CanvasDrawingOverlay drawings={overlayDrawings} />
        <CanvasLiveStrokeOverlay points={drawingPoints} freehandType={activeTool === "highlighter" ? "highlighter" : "pen"} />
        <Background variant={BackgroundVariant.Dots} gap={snapToGrid ? gridSize : CANVAS_GRID_SPACING} size={1} color="#27272a" />
        <Controls style={{ backgroundColor: "#18181b", borderColor: "#27272a", color: "#f4f4f5" }} />
        <MiniMap style={{ backgroundColor: "#18181b", borderColor: "#27272a", borderRadius: 8 }} nodeColor="#3b82f6" maskColor="rgba(0, 0, 0, 0.7)" />
      </ReactFlow>
    </div>
  );
};

export const CanvasWorkspace: React.FC<CanvasWorkspaceProps> = (props) => (
  <ReactFlowProvider><CanvasInner {...props} /></ReactFlowProvider>
);
