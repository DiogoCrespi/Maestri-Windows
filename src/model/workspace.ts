export type CanvasFrameArray = [[number, number], [number, number]]; // [[x,y], [w,h]]

export interface CanvasFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function frameToArray(frame: CanvasFrame): CanvasFrameArray {
  return [
    [frame.x, frame.y],
    [frame.width, frame.height],
  ];
}

export function arrayToFrame(arr: CanvasFrameArray): CanvasFrame {
  if (
    !Array.isArray(arr) ||
    arr.length !== 2 ||
    !Array.isArray(arr[0]) ||
    arr[0].length !== 2 ||
    !Array.isArray(arr[1]) ||
    arr[1].length !== 2
  ) {
    throw new Error("Invalid frame format, expected [[x,y],[w,h]]");
  }
  return {
    x: arr[0][0],
    y: arr[0][1],
    width: arr[1][0],
    height: arr[1][1],
  };
}

export interface TerminalContent {
  agentType: string;
  command: string;
  name: string;
  icon: string;
  color: string;
  id: string;
  shellPath: string;
  workingDirectory: string;
  status: string;
  isManager: boolean;
  monitorWithOmbro: boolean;
  autoScrollLocked: boolean;
  shortcutMode: { kind: string };
  assignedRoleId?: string | null;
  scrollbackFile?: string | null;
  scrollbackLineCount: number;
  lastActiveAt?: string | null;
  themeId?: string | null;
  fontFamily?: string | null;
  fontSize?: number | null;
  args?: string[];
  env?: Record<string, string>;
}

export interface StickyNoteContent {
  color: string;
  fileName?: string | null;
  fontSize: number;
  hasCustomName: boolean;
  isPreviewing: boolean;
  storageMode: { managed: Record<string, unknown> } | { custom: { _0: string } };
}

export interface PortalContent {
  id: string;
  name: string;
  currentURL: string;
  source: { none: Record<string, unknown> } | { url: { _0: string } };
  status: string;
  chromeHidden: boolean;
  storageScope: string;
}

export interface FileTreeContent {
  name: string;
  rootPath: string;
  viewMode: string;
}

export interface TextContent {
  text: string;
  fontSize: number;
  fontWeight: string;
  color: string;
  alignment: string;
  fontFamily: string;
}

export interface ShapeContent {
  shapeType: "rect" | "ellipse" | "diamond";
  fillColor: string;
  strokeColor: string;
  strokeWidth: number;
  strokeStyle: "solid" | "dashed" | "dotted";
  fillStyle: "solid" | "none" | "hatched" | "crossHatched";
  text: string;
  fontSize: number;
  rotation: number;
}

export interface StrokeContent {
  strokeType: "line" | "arrow";
  startPoint: { x: number; y: number };
  endPoint: { x: number; y: number };
  controlPoint?: { x: number; y: number } | null;
  strokeColor: string;
  strokeWidth: number;
  strokeStyle: "solid" | "dashed" | "dotted";
}

export interface FreehandContent {
  freehandType: "pen" | "highlighter";
  points: Array<{ x: number; y: number }>;
  strokeColor: string;
  strokeWidth: number;
  opacity: number;
  rotation: number;
}

export type NodeContent =
  | { terminal: { _0: TerminalContent } }
  | { stickyNote: { _0: StickyNoteContent } }
  | { portal: { _0: PortalContent } }
  | { fileTree: { _0: FileTreeContent } }
  | { text: { _0: TextContent } }
  | { shape: { _0: ShapeContent } }
  | { stroke: { _0: StrokeContent } }
  | { freehand: { _0: FreehandContent } };

export interface CanvasNode {
  id: string;
  frame: CanvasFrameArray;
  content: NodeContent;
  zIndex: number;
  isLocked: boolean;
  createdAt: string;
  lastModifiedAt: string;
}

export interface TerminalConnection {
  id: string;
  createdAt: string;
  terminalIdA: string;
  terminalIdB: string;
  ropePoints: number[][];
}

export interface NoteConnection {
  id: string;
  createdAt: string;
  terminalId: string;
  noteNodeId: string;
  ropePoints: number[][];
}

export interface PortalConnection {
  id: string;
  createdAt: string;
  terminalId: string;
  portalNodeId: string;
  ropePoints: number[][];
}

export interface PortalToPortalConnection {
  id: string;
  createdAt: string;
  portalIdA: string;
  portalIdB: string;
  ropePoints: number[][];
}

export interface NoteToNoteConnection {
  id: string;
  createdAt: string;
  noteNodeIdA: string;
  noteNodeIdB: string;
  ropePoints: number[][];
}

export interface CrossFloorConnection {
  id: string;
  createdAt: string;
  nodeIdA: string;
  floorIdA?: string | null;
  nodeIdB: string;
  floorIdB?: string | null;
  ropePoints: number[][];
}

export interface FloorEntry {
  id: string;
  name: string;
  branchName: string;
  worktreePath: string;
  hooks: Record<string, unknown>;
  createdAt: string;
}

export interface Drawing {
  id: string;
  points: number[][];
  color: string;
  lineWidth: number;
  createdAt: string;
}

export interface WorkspacePayload {
  id: string;
  name: string;
  icon: string;
  isPinned: boolean;
  locationType: string;
  workingDirectory: string;
  preferredIDE: string;
  syncConfigFiles: boolean;
  canvasOrigin: { x: number; y: number };
  canvasZoom: number;
  nodes: CanvasNode[];
  connections: TerminalConnection[];
  noteConnections: NoteConnection[];
  portalConnections: PortalConnection[];
  portalToPortalConnections: PortalToPortalConnection[];
  noteToNoteConnections: NoteToNoteConnection[];
  crossFloorConnections: CrossFloorConnection[];
  floors: FloorEntry[];
  drawings: Drawing[];
  createdAt: string;
  lastOpenedAt?: string | null;
  lastModifiedAt: string;
}

export interface WorkspaceDocument {
  schemaVersion: number;
  type: string;
  payload: WorkspacePayload;
}

export const SCHEMA_VERSION = 2;

export function parseWorkspaceDocument(input: unknown): WorkspaceDocument {
  if (typeof input !== "object" || input === null) {
    throw new Error("Invalid workspace JSON: root must be an object");
  }

  const raw = input as Record<string, any>;

  if (typeof raw.schemaVersion !== "number") {
    throw new Error("Invalid workspace JSON: missing or invalid schemaVersion");
  }

  if (raw.type !== "workspace") {
    throw new Error(`Invalid workspace JSON: unexpected type '${raw.type}'`);
  }

  if (typeof raw.payload !== "object" || raw.payload === null) {
    throw new Error("Invalid workspace JSON: payload must be an object");
  }

  let payload = { ...raw.payload };
  let schemaVersion = raw.schemaVersion;

  // Migration v1 to v2
  if (schemaVersion < SCHEMA_VERSION) {
    schemaVersion = SCHEMA_VERSION;
    payload.portalToPortalConnections = payload.portalToPortalConnections ?? [];
    payload.noteToNoteConnections = payload.noteToNoteConnections ?? [];
    payload.crossFloorConnections = payload.crossFloorConnections ?? [];
    payload.floors = payload.floors ?? [];
    payload.drawings = payload.drawings ?? [];
    payload.icon = payload.icon ?? "folder";
    payload.isPinned = payload.isPinned ?? false;
    payload.locationType = payload.locationType ?? "local";
    payload.preferredIDE = payload.preferredIDE ?? "cursor";
    payload.syncConfigFiles = payload.syncConfigFiles ?? false;
  }

  // Validate nodes and apply defaults
  if (Array.isArray(payload.nodes)) {
    payload.nodes = payload.nodes.map((node: any) => {
      if (typeof node !== "object" || node === null) {
        throw new Error("Invalid CanvasNode: must be an object");
      }
      arrayToFrame(node.frame); // Validates frame format
      return {
        ...node,
        zIndex: node.zIndex ?? 0,
        isLocked: node.isLocked ?? false,
        createdAt: node.createdAt ?? new Date().toISOString(),
        lastModifiedAt: node.lastModifiedAt ?? new Date().toISOString(),
      };
    });
  } else {
    payload.nodes = [];
  }

  payload.connections = payload.connections ?? [];
  payload.noteConnections = payload.noteConnections ?? [];
  payload.portalConnections = payload.portalConnections ?? [];
  payload.portalToPortalConnections = payload.portalToPortalConnections ?? [];
  payload.noteToNoteConnections = payload.noteToNoteConnections ?? [];
  payload.crossFloorConnections = payload.crossFloorConnections ?? [];
  payload.floors = payload.floors ?? [];
  payload.drawings = payload.drawings ?? [];

  return {
    ...raw,
    schemaVersion,
    type: "workspace",
    payload: payload as WorkspacePayload,
  };
}
