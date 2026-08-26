import { describe, it, expect, beforeEach } from "vitest";
import {
  useWorkspaceStore,
  canvasNodeToReactFlowNode,
  reactFlowNodeToCanvasNode,
  terminalConnectionToReactFlowEdge,
  reactFlowEdgeToTerminalConnection,
  classifyConnectionType,
} from "./workspaceStore";
import testWorkspaceFixture from "../model/TestWorkspace.json";
import type { CanvasNode, TerminalConnection, WorkspaceDocument } from "../model/workspace";

describe("workspaceStore & React Flow Conversions", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      currentDocument: null,
      nodes: [],
      edges: [],
      isDirty: false,
    });
  });

  it("converts CanvasNode with terminal content to ReactFlowNode and back", () => {
    const rawNode = testWorkspaceFixture.payload.nodes[0] as unknown as CanvasNode;
    const rfNode = canvasNodeToReactFlowNode(rawNode);

    expect(rfNode.id).toBe("00000000-0000-0000-0000-000000000002");
    expect(rfNode.type).toBe("terminal");
    expect(rfNode.position).toEqual({ x: 100, y: 200 });
    expect(rfNode.width).toBe(400);
    expect(rfNode.height).toBe(300);
    if (!("terminal" in rawNode.content)) throw new Error("fixture terminal missing");
    expect(rfNode.data.content).toEqual(rawNode.content.terminal._0);
    expect(rfNode.data.contentVariant).toBe("terminal");

    const convertedBack = reactFlowNodeToCanvasNode(rfNode);
    expect(convertedBack.id).toBe(rawNode.id);
    expect(convertedBack.frame).toEqual([[100, 200], [400, 300]]);
    expect(convertedBack.content).toEqual(rawNode.content);
  });

  it("converts TerminalConnection to ReactFlowEdge and back", () => {
    const conn: TerminalConnection = {
      id: "conn-1",
      createdAt: "2026-05-16T00:00:00Z",
      terminalIdA: "term-a",
      terminalIdB: "term-b",
      ropePoints: [[10, 20], [30, 40]],
    };

    const edge = terminalConnectionToReactFlowEdge(conn);
    expect(edge.id).toBe("conn-1");
    expect(edge.source).toBe("term-a");
    expect(edge.target).toBe("term-b");

    const connBack = reactFlowEdgeToTerminalConnection(edge);
    expect(connBack.id).toBe("conn-1");
    expect(connBack.terminalIdA).toBe("term-a");
    expect(connBack.terminalIdB).toBe("term-b");
    expect(connBack.ropePoints).toEqual([[10, 20], [30, 40]]);
  });

  it("maps schema terminal content IDs to canvas node IDs and back", () => {
    const conn: TerminalConnection = {
      id: "conn-1",
      createdAt: "2026-05-16T00:00:00Z",
      terminalIdA: "terminal-content-a",
      terminalIdB: "terminal-content-b",
      ropePoints: [],
    };
    const edge = terminalConnectionToReactFlowEdge(conn, new Map([
      ["terminal-content-a", "canvas-node-a"],
      ["terminal-content-b", "canvas-node-b"],
    ]));
    expect(edge.source).toBe("canvas-node-a");
    expect(edge.target).toBe("canvas-node-b");

    expect(reactFlowEdgeToTerminalConnection(edge, new Map([
      ["canvas-node-a", "terminal-content-a"],
      ["canvas-node-b", "terminal-content-b"],
    ]))).toEqual(conn);
  });

  it("loads workspace fixture into store and sets isDirty to false", () => {
    const store = useWorkspaceStore.getState();
    store.loadWorkspace(testWorkspaceFixture);

    const state = useWorkspaceStore.getState();
    expect(state.currentDocument).not.toBeNull();
    expect(state.nodes).toHaveLength(1);
    expect(state.nodes[0].id).toBe("00000000-0000-0000-0000-000000000002");
    expect(state.isDirty).toBe(false);
  });

  it("marks state as dirty when updating position or adding node", () => {
    const store = useWorkspaceStore.getState();
    store.loadWorkspace(testWorkspaceFixture);

    expect(useWorkspaceStore.getState().isDirty).toBe(false);

    store.updateNodePosition("00000000-0000-0000-0000-000000000002", { x: 150, y: 250 });

    const state = useWorkspaceStore.getState();
    expect(state.isDirty).toBe(true);
    expect(state.nodes[0].position).toEqual({ x: 150, y: 250 });
  });

  it("serializes store back to WorkspaceDocument preserving payload fields and updated node position", () => {
    const store = useWorkspaceStore.getState();
    store.loadWorkspace(testWorkspaceFixture);
    store.updateNodePosition("00000000-0000-0000-0000-000000000002", { x: 500, y: 600 });

    const serialized = store.serializeWorkspace();
    expect(serialized.schemaVersion).toBe(2);
    expect(serialized.type).toBe("workspace");
    expect(serialized.payload.name).toBe("Test Workspace");
    expect(serialized.payload.workingDirectory).toBe("/tmp/test");
    expect(serialized.payload.nodes[0].frame).toEqual([[500, 600], [400, 300]]);
    expect("terminal" in serialized.payload.nodes[0].content).toBe(true);
  });

  it("roundtrips macOS terminal IDs while React Flow uses canvas node IDs", () => {
    const first = testWorkspaceFixture.payload.nodes[0] as unknown as CanvasNode;
    if (!("terminal" in first.content)) throw new Error("fixture terminal missing");
    const second: CanvasNode = {
      ...first,
      id: "canvas-node-b",
      content: { terminal: { _0: { ...first.content.terminal._0, id: "terminal-content-b" } } },
    };
    const document = structuredClone(testWorkspaceFixture) as unknown as WorkspaceDocument;
    document.payload.nodes = [first, second];
    document.payload.connections = [{
      id: "connection-ab",
      createdAt: "2026-05-16T00:00:00Z",
      terminalIdA: first.content.terminal._0.id,
      terminalIdB: "terminal-content-b",
      ropePoints: [[1, 2]],
    }];

    useWorkspaceStore.getState().loadWorkspace(document);
    const edge = useWorkspaceStore.getState().edges[0];
    expect(edge.source).toBe(first.id);
    expect(edge.target).toBe(second.id);

    const serialized = useWorkspaceStore.getState().serializeWorkspace();
    expect(serialized.payload.connections[0].terminalIdA).toBe(first.content.terminal._0.id);
    expect(serialized.payload.connections[0].terminalIdB).toBe("terminal-content-b");
  });

  it("uses a Windows-safe directory for a new workspace", () => {
    expect(useWorkspaceStore.getState().serializeWorkspace().payload.workingDirectory).toBe("C:\\");
  });

  it("classifies every supported heterogeneous pair and rejects other nodes", () => {
    expect(classifyConnectionType("terminal", "terminal")).toBe("terminal");
    expect(classifyConnectionType("terminal", "stickyNote")).toBe("terminal-note");
    expect(classifyConnectionType("stickyNote", "terminal")).toBe("terminal-note");
    expect(classifyConnectionType("terminal", "portal")).toBe("terminal-portal");
    expect(classifyConnectionType("portal", "terminal")).toBe("terminal-portal");
    expect(classifyConnectionType("stickyNote", "stickyNote")).toBe("note-note");
    expect(classifyConnectionType("portal", "portal")).toBe("portal-portal");
    expect(classifyConnectionType("terminal", "fileTree")).toBeNull();
    expect(classifyConnectionType("text", "stickyNote")).toBeNull();
  });

  it("roundtrips all schema-v2 heterogeneous connections and their metadata", () => {
    const terminal = testWorkspaceFixture.payload.nodes[0] as unknown as CanvasNode;
    const nodeBase = {
      frame: [[0, 0], [200, 150]] as [[number, number], [number, number]],
      zIndex: 0,
      isLocked: false,
      createdAt: "2026-05-16T00:00:00Z",
      lastModifiedAt: "2026-05-16T00:00:00Z",
    };
    const note = (id: string): CanvasNode => ({
      ...nodeBase, id,
      content: { stickyNote: { _0: {
        color: "#fef08a", fontSize: 14, hasCustomName: false,
        isPreviewing: false, storageMode: { managed: {} },
      } } },
    });
    const portal = (id: string): CanvasNode => ({
      ...nodeBase, id,
      content: { portal: { _0: {
        id: `${id}-content`, name: id, currentURL: "https://example.com",
        source: { none: {} }, status: "idle", chromeHidden: false, storageScope: "workspace",
      } } },
    });
    const document = structuredClone(testWorkspaceFixture) as unknown as WorkspaceDocument;
    document.payload.nodes = [terminal, note("note-a"), note("note-b"), portal("portal-a"), portal("portal-b")];
    if (!("terminal" in terminal.content)) throw new Error("fixture terminal missing");
    const terminalId = terminal.content.terminal._0.id;
    document.payload.noteConnections = [{
      id: "terminal-note", terminalId, noteNodeId: "note-a",
      createdAt: "2026-01-01T00:00:00Z", ropePoints: [[1, 2], [3, 4]],
    }];
    document.payload.portalConnections = [{
      id: "terminal-portal", terminalId, portalNodeId: "portal-a",
      createdAt: "2026-01-02T00:00:00Z", ropePoints: [[5, 6]],
    }];
    document.payload.noteToNoteConnections = [{
      id: "note-note", noteNodeIdA: "note-a", noteNodeIdB: "note-b",
      createdAt: "2026-01-03T00:00:00Z", ropePoints: [[7, 8]],
    }];
    document.payload.portalToPortalConnections = [{
      id: "portal-portal", portalIdA: "portal-a", portalIdB: "portal-b",
      createdAt: "2026-01-04T00:00:00Z", ropePoints: [[9, 10]],
    }];

    useWorkspaceStore.getState().loadWorkspace(document);
    const state = useWorkspaceStore.getState();
    expect(state.edges.map((edge) => edge.data?.connectionType)).toEqual([
      "terminal-note", "terminal-portal", "note-note", "portal-portal",
    ]);
    expect(state.edges[0].source).toBe(terminal.id);
    expect(state.edges[0].target).toBe("note-a");

    // React Flow permits drawing these relationships in either direction; the
    // schema must still put the terminal in terminalId and the other node in its field.
    state.setEdges(state.edges.map((edge) =>
      edge.data?.connectionType === "terminal-note" || edge.data?.connectionType === "terminal-portal"
        ? { ...edge, source: edge.target, target: edge.source }
        : edge));
    const serialized = state.serializeWorkspace();
    expect(serialized.payload.noteConnections).toEqual(document.payload.noteConnections);
    expect(serialized.payload.portalConnections).toEqual(document.payload.portalConnections);
    expect(serialized.payload.noteToNoteConnections).toEqual(document.payload.noteToNoteConnections);
    expect(serialized.payload.portalToPortalConnections).toEqual(document.payload.portalToPortalConnections);
  });

  it("persists viewport origin and zoom in the workspace payload", () => {
    const store = useWorkspaceStore.getState();
    store.loadWorkspace(testWorkspaceFixture);
    store.updateViewport({ x: -320, y: 180 }, 1.35);

    const state = useWorkspaceStore.getState();
    expect(state.isDirty).toBe(true);
    expect(state.currentDocument?.payload.canvasOrigin).toEqual({ x: -320, y: 180 });
    expect(state.currentDocument?.payload.canvasZoom).toBe(1.35);
    expect(state.serializeWorkspace().payload.canvasZoom).toBe(1.35);
  });

  it("loads comprehensive golden fixture into workspaceStore, updates node position, refreshes lastModifiedAt timestamp on edit, and serializes back with 100% unknown field preservation", async () => {
    const goldenFixture = await import("../../tests/fixtures/macOS_v2_comprehensive_golden_workspace.json");
    const store = useWorkspaceStore.getState();

    store.loadWorkspace(goldenFixture.default);
    const loadedState = useWorkspaceStore.getState();

    expect(loadedState.nodes).toHaveLength(12);
    // 1 terminal connection + 4 heterogeneous connections loaded as React Flow edges = 5 edges
    expect(loadedState.edges).toHaveLength(5);
    expect(loadedState.isDirty).toBe(false);

    const oldLastModifiedAt = "2026-05-16T10:25:00.000Z";

    // Modify a node position (simulating user dragging a node on Windows canvas)
    store.updateNodePosition("20000000-0000-0000-0000-000000000001", { x: 250.5, y: 350.5 });
    expect(useWorkspaceStore.getState().isDirty).toBe(true);

    const serialized = store.serializeWorkspace();

    // Validate root unknown fields
    expect((serialized as unknown as Record<string, unknown>).customDocumentMeta).toBe("macOS-v2-golden-root-meta");

    // Validate payload unknown fields
    expect((serialized.payload as unknown as Record<string, unknown>).customPayloadMeta).toEqual({
      engine: "swift-codable-v2",
      experimentalFlag: true,
    });

    // Validate node unknown field, updated position, and REFRESHED lastModifiedAt (not keeping old timestamp!)
    const serializedTermNode = serialized.payload.nodes.find((n) => n.id === "20000000-0000-0000-0000-000000000001");
    expect(serializedTermNode).toBeDefined();
    expect(serializedTermNode?.frame).toEqual([[250.5, 350.5], [600, 400]]);
    expect(serializedTermNode?.createdAt).toBe("2026-05-16T10:20:30.123Z");
    expect(serializedTermNode?.lastModifiedAt).not.toBe(oldLastModifiedAt);
    expect(new Date(serializedTermNode!.lastModifiedAt).getTime()).toBeGreaterThan(new Date(oldLastModifiedAt).getTime());

    expect((serializedTermNode as unknown as Record<string, unknown>).customNodeMeta).toBe("term-node-attr");
    if (serializedTermNode && "terminal" in serializedTermNode.content) {
      expect((serializedTermNode.content.terminal._0 as unknown as Record<string, unknown>).customTerminalField).toBe("agent-extra");
    }

    // Validate all 6 connection types preserved
    expect(serialized.payload.connections).toHaveLength(1);
    expect(serialized.payload.noteConnections).toHaveLength(1);
    expect(serialized.payload.portalConnections).toHaveLength(1);
    expect(serialized.payload.portalToPortalConnections).toHaveLength(1);
    expect(serialized.payload.noteToNoteConnections).toHaveLength(1);
    expect(serialized.payload.crossFloorConnections).toHaveLength(1);

    expect((serialized.payload.connections[0] as unknown as Record<string, unknown>).customConnAttr).toBe("t2t-rope");
    expect((serialized.payload.crossFloorConnections[0] as unknown as Record<string, unknown>).customCrossFloorMeta).toBe("floor-bridge");

    // Validate floors & drawings preserved
    expect(serialized.payload.floors).toHaveLength(1);
    expect((serialized.payload.floors[0] as unknown as Record<string, unknown>).customFloorAttr).toBe("floor-extra");

    expect(serialized.payload.drawings).toHaveLength(1);
    expect((serialized.payload.drawings[0] as unknown as Record<string, unknown>).customDrawingAttr).toBe("hand-drawn-circle");
  });

  it("loads floors golden fixture into workspaceStore, updates node position, refreshes lastModifiedAt timestamp, and preserves FloorEntry and CrossFloorConnection", async () => {
    const floorsFixture = await import("../../tests/fixtures/macOS_v2_floors_workspace.json");
    const store = useWorkspaceStore.getState();

    store.loadWorkspace(floorsFixture.default);
    const loadedState = useWorkspaceStore.getState();

    expect(loadedState.nodes).toHaveLength(2);
    expect(loadedState.isDirty).toBe(false);

    const oldLastModifiedAt = "2026-05-16T10:25:00.000Z";

    // Edit a node on Windows
    store.updateNodePosition("20000000-0000-0000-0000-000000000001", { x: 300.0, y: 400.0 });
    expect(useWorkspaceStore.getState().isDirty).toBe(true);

    const serialized = store.serializeWorkspace();

    expect(serialized.payload.floors).toHaveLength(1);
    const floor = serialized.payload.floors[0];
    expect(floor.name).toBe("Feature Branch Floor");
    expect(floor.hooks.setup).toEqual(["git status", "npm install"]);
    expect(floor.hooks.run).toEqual(["npm test"]);
    expect(floor.hooks.teardown).toEqual(["echo cleanup"]);
    expect(floor.hooks.autoRunSetup).toBe(true);
    expect((floor.hooks as unknown as Record<string, unknown>).customHookMeta).toBe("extra-hook-field");
    expect((floor as unknown as Record<string, unknown>).customFloorMeta).toBe("floor-attr");

    expect(serialized.payload.crossFloorConnections).toHaveLength(1);
    const crossConn = serialized.payload.crossFloorConnections[0];
    expect(crossConn.floorIdA).toBeUndefined();
    expect(crossConn.floorIdB).toBe("60000000-0000-0000-0000-000000000001");
    expect((crossConn as unknown as Record<string, unknown>).customCrossFloorMeta).toBe("floor-bridge");

    const updatedNode = serialized.payload.nodes.find((n) => n.id === "20000000-0000-0000-0000-000000000001");
    expect(updatedNode?.lastModifiedAt).not.toBe(oldLastModifiedAt);
    expect(new Date(updatedNode!.lastModifiedAt).getTime()).toBeGreaterThan(new Date(oldLastModifiedAt).getTime());
  });

  it("manages floor entries in workspaceStore payload preserving customHookMeta and supporting dirty: false", () => {
    useWorkspaceStore.getState().loadWorkspace(testWorkspaceFixture);
    const docBefore = useWorkspaceStore.getState().currentDocument;
    const oldLastModifiedAt = docBefore!.payload.lastModifiedAt;
    useWorkspaceStore.setState({ isDirty: false });

    const newFloor = {
      id: "floor-test-1",
      name: "Feature Test",
      branchName: "feat/test",
      worktreePath: "C:\\Nestjs\\open-maestri\\.worktrees\\win-floor-test",
      hooks: { setup: ["npm install"], run: [], teardown: [], autoRunSetup: true, customHookMeta: "my-custom-meta" },
      createdAt: "2026-08-26T00:00:00.000Z",
    };

    // Test setFloors with dirty: false
    useWorkspaceStore.getState().setFloors([newFloor], { dirty: false });
    expect(useWorkspaceStore.getState().isDirty).toBe(false);
    expect(useWorkspaceStore.getState().currentDocument?.payload.lastModifiedAt).toBe(oldLastModifiedAt);
    let docFloors = useWorkspaceStore.getState().currentDocument?.payload.floors;
    expect(docFloors).toHaveLength(1);
    expect(docFloors?.[0].id).toBe("floor-test-1");

    // Test updateFloorHooks preserves unknown field customHookMeta
    useWorkspaceStore.getState().updateFloorHooks("floor-test-1", {
      setup: ["npm install", "npm run build"],
      run: ["npm test"],
      teardown: [],
      autoRunSetup: false,
    });
    expect(useWorkspaceStore.getState().isDirty).toBe(true);
    docFloors = useWorkspaceStore.getState().currentDocument?.payload.floors;
    expect(docFloors?.[0].hooks).toEqual({
      setup: ["npm install", "npm run build"],
      run: ["npm test"],
      teardown: [],
      autoRunSetup: false,
      customHookMeta: "my-custom-meta",
    });

    // Test setFloors with new list
    useWorkspaceStore.getState().setFloors([]);
    docFloors = useWorkspaceStore.getState().currentDocument?.payload.floors;
    expect(docFloors).toHaveLength(0);
  });
});
