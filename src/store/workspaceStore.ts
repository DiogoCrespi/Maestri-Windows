import { create } from "zustand";
import type { Edge as ReactFlowEdge, Node as ReactFlowNode } from "@xyflow/react";
import type {
  CanvasNode,
  NoteConnection,
  NoteToNoteConnection,
  NodeContent,
  PortalConnection,
  PortalToPortalConnection,
  TerminalConnection,
  WorkspaceDocument,
  WorkspacePayload,
} from "../model/workspace";
import {
  arrayToFrame,
  frameToArray,
  parseWorkspaceDocument,
  SCHEMA_VERSION,
} from "../model/workspace";

export interface WorkspaceStoreState {
  currentDocument: WorkspaceDocument | null;
  nodes: ReactFlowNode[];
  edges: ReactFlowEdge[];
  isDirty: boolean;
  loadWorkspace: (docOrJson: unknown) => void;
  serializeWorkspace: () => WorkspaceDocument;
  setNodes: (nodes: ReactFlowNode[], options?: { dirty?: boolean }) => void;
  setEdges: (edges: ReactFlowEdge[]) => void;
  addNode: (node: ReactFlowNode) => void;
  updateNodePosition: (id: string, position: { x: number; y: number }) => void;
  updateNodeDimensions: (id: string, width: number, height: number) => void;
  updateViewport: (origin: { x: number; y: number }, zoom: number) => void;
  addEdge: (edge: ReactFlowEdge) => void;
  markClean: () => void;
}

type NodeContentVariant =
  | "terminal"
  | "stickyNote"
  | "portal"
  | "fileTree"
  | "text"
  | "shape"
  | "stroke"
  | "freehand";

export type WorkspaceConnectionType =
  | "terminal"
  | "terminal-note"
  | "terminal-portal"
  | "note-note"
  | "portal-portal";

export function classifyConnectionType(
  sourceType: string | undefined,
  targetType: string | undefined,
): WorkspaceConnectionType | null {
  const pair = new Set([sourceType, targetType]);
  if (sourceType === "terminal" && targetType === "terminal") return "terminal";
  if (pair.has("terminal") && pair.has("stickyNote")) return "terminal-note";
  if (pair.has("terminal") && pair.has("portal")) return "terminal-portal";
  if (sourceType === "stickyNote" && targetType === "stickyNote") return "note-note";
  if (sourceType === "portal" && targetType === "portal") return "portal-portal";
  return null;
}

function getNodeContentVariant(content: NodeContent): NodeContentVariant {
  const variant = Object.keys(content)[0] as NodeContentVariant | undefined;
  if (!variant || !(content as unknown as Record<string, unknown>)[variant]) {
    throw new Error("Invalid NodeContent: expected one enum variant");
  }
  return variant;
}

function unwrapNodeContent(content: NodeContent): Record<string, unknown> {
  const variant = getNodeContentVariant(content);
  const wrapper = (content as unknown as Record<string, { _0?: unknown }>)[variant];
  if (!wrapper || typeof wrapper !== "object" || !("_0" in wrapper)) {
    throw new Error(`Invalid NodeContent '${variant}': missing _0 payload`);
  }
  return wrapper._0 as Record<string, unknown>;
}

function wrapNodeContent(variant: NodeContentVariant, payload: unknown): NodeContent {
  return { [variant]: { _0: payload } } as NodeContent;
}

export function canvasNodeToReactFlowNode(node: CanvasNode): ReactFlowNode {
  const frame = arrayToFrame(node.frame);
  const nodeType = getNodeContentVariant(node.content);
  return {
    id: node.id,
    type: nodeType,
    position: { x: frame.x, y: frame.y },
    width: frame.width,
    height: frame.height,
    style: { width: frame.width, height: frame.height },
    zIndex: node.zIndex,
    data: {
      content: unwrapNodeContent(node.content),
      contentVariant: nodeType,
      isLocked: node.isLocked,
      createdAt: node.createdAt,
      lastModifiedAt: node.lastModifiedAt,
      _rawNode: node,
    },
  };
}

export function reactFlowNodeToCanvasNode(rfNode: ReactFlowNode): CanvasNode {
  const width = rfNode.width ?? (typeof rfNode.style?.width === "number" ? rfNode.style.width : 400);
  const height = rfNode.height ?? (typeof rfNode.style?.height === "number" ? rfNode.style.height : 300);
  const data = (rfNode.data || {}) as Record<string, unknown>;
  const contentVariant = (data.contentVariant ?? rfNode.type) as NodeContentVariant | undefined;
  if (!data.content || !contentVariant) {
    throw new Error(`ReactFlowNode ${rfNode.id} missing content data`);
  }

  const rawNode = (data._rawNode ?? {}) as Record<string, unknown>;
  const rawContent = (rawNode.content ?? {}) as Record<string, unknown>;
  const rawVariantWrapper = (rawContent[contentVariant] ?? {}) as Record<string, unknown>;
  const rawInner0 = (rawVariantWrapper._0 ?? {}) as Record<string, unknown>;

  const mergedInner0 = {
    ...rawInner0,
    ...(data.content as Record<string, unknown>),
  };

  const finalContent = {
    ...rawContent,
    [contentVariant]: {
      ...rawVariantWrapper,
      _0: mergedInner0,
    },
  } as NodeContent;

  return {
    ...rawNode,
    id: rfNode.id,
    frame: frameToArray({ x: rfNode.position.x, y: rfNode.position.y, width, height }),
    content: finalContent,
    zIndex: rfNode.zIndex ?? (rawNode.zIndex as number | undefined) ?? 0,
    isLocked: data.isLocked === true,
    createdAt: typeof data.createdAt === "string" ? data.createdAt : (rawNode.createdAt as string | undefined) ?? new Date().toISOString(),
    lastModifiedAt: (rawNode.lastModifiedAt as string | undefined) ?? new Date().toISOString(),
  } as CanvasNode;
}

export function terminalConnectionToReactFlowEdge(
  conn: TerminalConnection,
  terminalNodeIdByContentId: ReadonlyMap<string, string> = new Map(),
): ReactFlowEdge {
  return {
    id: conn.id,
    source: terminalNodeIdByContentId.get(conn.terminalIdA) ?? conn.terminalIdA,
    target: terminalNodeIdByContentId.get(conn.terminalIdB) ?? conn.terminalIdB,
    type: "default",
    data: {
      ...(conn as unknown as Record<string, unknown>),
      createdAt: conn.createdAt,
      ropePoints: conn.ropePoints,
      connectionType: "terminal",
      _rawConnection: conn,
    },
  };
}

export function reactFlowEdgeToTerminalConnection(
  edge: ReactFlowEdge,
  terminalContentIdByNodeId: ReadonlyMap<string, string> = new Map(),
): TerminalConnection {
  const data = (edge.data || {}) as Record<string, unknown>;
  const rawConn = (data._rawConnection ?? {}) as Record<string, unknown>;
  return {
    ...rawConn,
    id: edge.id,
    createdAt: typeof data.createdAt === "string" ? data.createdAt : new Date().toISOString(),
    terminalIdA: terminalContentIdByNodeId.get(edge.source) ?? edge.source,
    terminalIdB: terminalContentIdByNodeId.get(edge.target) ?? edge.target,
    ropePoints: Array.isArray(data.ropePoints) ? (data.ropePoints as number[][]) : [],
  } as TerminalConnection;
}

function connectionEdge(
  id: string,
  source: string,
  target: string,
  createdAt: string,
  ropePoints: number[][],
  connectionType: WorkspaceConnectionType,
  rawConnection?: unknown,
): ReactFlowEdge {
  return {
    id,
    source,
    target,
    type: "default",
    data: {
      ...(rawConnection as Record<string, unknown> | undefined),
      createdAt,
      ropePoints,
      connectionType,
      _rawConnection: rawConnection,
    },
  };
}

function edgeMetadata(edge: ReactFlowEdge): Record<string, unknown> {
  const data = (edge.data || {}) as Record<string, unknown>;
  const rawConn = (data._rawConnection ?? {}) as Record<string, unknown>;
  return {
    ...rawConn,
    createdAt: typeof data.createdAt === "string" ? data.createdAt : new Date().toISOString(),
    ropePoints: Array.isArray(data.ropePoints) ? (data.ropePoints as number[][]) : [],
  };
}

function terminalAndOtherNodeIds(
  edge: ReactFlowEdge,
  nodeTypeById: ReadonlyMap<string, string | undefined>,
): { terminalNodeId: string; otherNodeId: string } {
  if (nodeTypeById.get(edge.source) === "terminal") {
    return { terminalNodeId: edge.source, otherNodeId: edge.target };
  }
  return { terminalNodeId: edge.target, otherNodeId: edge.source };
}

export const useWorkspaceStore = create<WorkspaceStoreState>((set, get) => ({
  currentDocument: null,
  nodes: [],
  edges: [],
  isDirty: false,

  loadWorkspace: (docOrJson) => {
    const doc = parseWorkspaceDocument(docOrJson);
    const terminalNodeIdByContentId = new Map<string, string>();
    for (const node of doc.payload.nodes) {
      if ("terminal" in node.content) terminalNodeIdByContentId.set(node.content.terminal._0.id, node.id);
    }
    const heterogeneousEdges: ReactFlowEdge[] = [
      ...doc.payload.noteConnections.map((connection: NoteConnection) => connectionEdge(
        connection.id,
        terminalNodeIdByContentId.get(connection.terminalId) ?? connection.terminalId,
        connection.noteNodeId,
        connection.createdAt,
        connection.ropePoints,
        "terminal-note",
        connection,
      )),
      ...doc.payload.portalConnections.map((connection: PortalConnection) => connectionEdge(
        connection.id,
        terminalNodeIdByContentId.get(connection.terminalId) ?? connection.terminalId,
        connection.portalNodeId,
        connection.createdAt,
        connection.ropePoints,
        "terminal-portal",
        connection,
      )),
      ...doc.payload.noteToNoteConnections.map((connection: NoteToNoteConnection) => connectionEdge(
        connection.id, connection.noteNodeIdA, connection.noteNodeIdB,
        connection.createdAt, connection.ropePoints, "note-note", connection,
      )),
      ...doc.payload.portalToPortalConnections.map((connection: PortalToPortalConnection) => connectionEdge(
        connection.id, connection.portalIdA, connection.portalIdB,
        connection.createdAt, connection.ropePoints, "portal-portal", connection,
      )),
    ];
    set({
      currentDocument: doc,
      nodes: doc.payload.nodes.map(canvasNodeToReactFlowNode),
      edges: doc.payload.connections.map((connection) =>
        terminalConnectionToReactFlowEdge(connection, terminalNodeIdByContentId)).concat(heterogeneousEdges),
      isDirty: false,
    });
  },

  serializeWorkspace: () => {
    const { currentDocument, nodes, edges } = get();
    const canvasNodes = nodes.map(reactFlowNodeToCanvasNode);
    const terminalContentIdByNodeId = new Map<string, string>();
    for (const node of canvasNodes) {
      if ("terminal" in node.content) terminalContentIdByNodeId.set(node.id, node.content.terminal._0.id);
    }
    const nodeTypeById = new Map(nodes.map((node) => [node.id, node.type]));
    const terminalConnections: TerminalConnection[] = [];
    const noteConnections: NoteConnection[] = [];
    const portalConnections: PortalConnection[] = [];
    const noteToNoteConnections: NoteToNoteConnection[] = [];
    const portalToPortalConnections: PortalToPortalConnection[] = [];
    for (const edge of edges) {
      const storedType = (edge.data as Record<string, unknown> | undefined)?.connectionType;
      const connectionType = typeof storedType === "string"
        ? storedType as WorkspaceConnectionType
        : classifyConnectionType(nodeTypeById.get(edge.source), nodeTypeById.get(edge.target));
      if (!connectionType) continue;
      const metadata = edgeMetadata(edge);
      if (connectionType === "terminal") {
        terminalConnections.push(reactFlowEdgeToTerminalConnection(edge, terminalContentIdByNodeId));
      } else if (connectionType === "terminal-note" || connectionType === "terminal-portal") {
        const { terminalNodeId, otherNodeId } = terminalAndOtherNodeIds(edge, nodeTypeById);
        const terminalId = terminalContentIdByNodeId.get(terminalNodeId) ?? terminalNodeId;
        if (connectionType === "terminal-note") {
          noteConnections.push({ ...metadata, id: edge.id, terminalId, noteNodeId: otherNodeId } as NoteConnection);
        } else {
          portalConnections.push({ ...metadata, id: edge.id, terminalId, portalNodeId: otherNodeId } as PortalConnection);
        }
      } else if (connectionType === "note-note") {
        noteToNoteConnections.push({ ...metadata, id: edge.id, noteNodeIdA: edge.source, noteNodeIdB: edge.target } as NoteToNoteConnection);
      } else if (connectionType === "portal-portal") {
        portalToPortalConnections.push({ ...metadata, id: edge.id, portalIdA: edge.source, portalIdB: edge.target } as PortalToPortalConnection);
      }
    }

    const now = new Date().toISOString();
    const basePayload: WorkspacePayload = currentDocument
      ? { ...currentDocument.payload }
      : {
          id: "00000000-0000-0000-0000-000000000001",
          name: "Untitled Workspace",
          icon: "folder",
          isPinned: false,
          locationType: "local",
          workingDirectory: "C:\\",
          preferredIDE: "cursor",
          syncConfigFiles: false,
          canvasOrigin: { x: 9800, y: 8500 },
          canvasZoom: 1,
          nodes: [], connections: [], noteConnections: [], portalConnections: [],
          portalToPortalConnections: [], noteToNoteConnections: [], crossFloorConnections: [],
          floors: [], drawings: [], createdAt: now, lastModifiedAt: now,
        };
    return {
      ...currentDocument,
      schemaVersion: currentDocument?.schemaVersion ?? SCHEMA_VERSION,
      type: "workspace",
      payload: {
        ...basePayload,
        nodes: canvasNodes,
        connections: terminalConnections,
        noteConnections,
        portalConnections,
        noteToNoteConnections,
        portalToPortalConnections,
        crossFloorConnections: basePayload.crossFloorConnections ?? [],
        floors: basePayload.floors ?? [],
        drawings: basePayload.drawings ?? [],
        lastModifiedAt: now,
      },
    };
  },

  setNodes: (nodes, options) => set((state) => ({
    nodes,
    isDirty: options?.dirty === false ? state.isDirty : true,
  })),
  setEdges: (edges) => set({ edges, isDirty: true }),
  addNode: (node) => set((state) => ({ nodes: [...state.nodes, node], isDirty: true })),
  updateNodePosition: (id, position) => set((state) => ({
    nodes: state.nodes.map((node) => node.id === id ? { ...node, position } : node), isDirty: true,
  })),
  updateNodeDimensions: (id, width, height) => set((state) => ({
    nodes: state.nodes.map((node) => node.id === id
      ? { ...node, width, height, style: { ...node.style, width, height } } : node),
    isDirty: true,
  })),
  updateViewport: (origin, zoom) => set((state) => ({
    currentDocument: state.currentDocument
      ? {
          ...state.currentDocument,
          payload: {
            ...state.currentDocument.payload,
            canvasOrigin: origin,
            canvasZoom: zoom,
          },
        }
      : state.currentDocument,
    isDirty: true,
  })),
  addEdge: (edge) => set((state) => ({ edges: [...state.edges, edge], isDirty: true })),
  markClean: () => set({ isDirty: false }),
}));
