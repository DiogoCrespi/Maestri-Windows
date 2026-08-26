import { describe, it, expect } from "vitest";
import {
  parseWorkspaceDocument,
  frameToArray,
  arrayToFrame,
  SCHEMA_VERSION,
  WorkspaceDocument,
} from "./workspace";
import testWorkspaceFixture from "./TestWorkspace.json";

describe("Workspace Model & Persistence Schema", () => {
  it("converts frame to array and array to frame correctly", () => {
    const frame = { x: 100, y: 200, width: 400, height: 300 };
    const arr = frameToArray(frame);
    expect(arr).toEqual([[100, 200], [400, 300]]);
    const restored = arrayToFrame(arr);
    expect(restored).toEqual(frame);
  });

  it("throws error when parsing invalid frame format", () => {
    // @ts-expect-error invalid format test
    expect(() => arrayToFrame([100, 200])).toThrow("Invalid frame format");
  });

  it("parses TestWorkspace.json fixture accurately", () => {
    const doc = parseWorkspaceDocument(testWorkspaceFixture);
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION);
    expect(doc.type).toBe("workspace");
    expect(doc.payload.id).toBe("00000000-0000-0000-0000-000000000001");
    expect(doc.payload.nodes).toHaveLength(1);

    const node = doc.payload.nodes[0];
    expect(node.frame).toEqual([[100, 200], [400, 300]]);
    expect("terminal" in node.content).toBe(true);

    if ("terminal" in node.content) {
      expect(node.content.terminal._0.name).toBe("Agent Terminal");
      expect(node.content.terminal._0.agentType).toBe("claude_code");
    }
  });

  it("performs a exact round-trip serialization/deserialization", () => {
    const parsedOriginal = parseWorkspaceDocument(testWorkspaceFixture);
    const jsonString = JSON.stringify(parsedOriginal);
    const reParsed = parseWorkspaceDocument(JSON.parse(jsonString));

    expect(reParsed).toEqual(parsedOriginal);
  });

  it("migrates schemaVersion 1 to schemaVersion 2 correctly", () => {
    const v1Doc = {
      schemaVersion: 1,
      type: "workspace",
      payload: {
        id: "00000000-0000-0000-0000-000000000009",
        name: "Legacy V1 Workspace",
        workingDirectory: "/tmp/legacy",
        canvasOrigin: { x: 0, y: 0 },
        canvasZoom: 1,
        createdAt: "2026-01-01T00:00:00Z",
        lastModifiedAt: "2026-01-01T00:00:00Z",
        nodes: [],
        connections: [],
      },
    };

    const doc = parseWorkspaceDocument(v1Doc);
    expect(doc.schemaVersion).toBe(2);
    expect(doc.payload.portalToPortalConnections).toEqual([]);
    expect(doc.payload.noteToNoteConnections).toEqual([]);
    expect(doc.payload.crossFloorConnections).toEqual([]);
    expect(doc.payload.floors).toEqual([]);
    expect(doc.payload.drawings).toEqual([]);
    expect(doc.payload.icon).toBe("folder");
    expect(doc.payload.isPinned).toBe(false);
  });

  it("parses macOS v2 minimal fixture without external path dependency", async () => {
    const minimalFixture = await import("../../tests/fixtures/macOS_v2_minimal_workspace.json");
    const doc = parseWorkspaceDocument(minimalFixture.default);
    expect(doc.schemaVersion).toBe(2);
    expect(doc.type).toBe("workspace");
    expect(doc.payload.id).toBe("00000000-0000-0000-0000-000000000001");
    expect(doc.payload.name).toBe("Test Workspace");
  });

  it("parses macOS v2 comprehensive golden fixture with valid canonical Swift UUIDs", async () => {
    const goldenFixture = await import("../../tests/fixtures/macOS_v2_comprehensive_golden_workspace.json");
    const doc = parseWorkspaceDocument(goldenFixture.default);

    const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

    // 1. Root Payload ID
    expect(doc.payload.id).toMatch(UUID_REGEX);

    // 2. All Nodes IDs & Content IDs
    expect(doc.payload.nodes).toHaveLength(12);
    for (const node of doc.payload.nodes) {
      expect(node.id).toMatch(UUID_REGEX);
      if ("terminal" in node.content) {
        expect(node.content.terminal._0.id).toMatch(UUID_REGEX);
        if (node.content.terminal._0.assignedRoleId) {
          expect(node.content.terminal._0.assignedRoleId).toMatch(UUID_REGEX);
        }
      } else if ("portal" in node.content) {
        expect(node.content.portal._0.id).toMatch(UUID_REGEX);
      }
    }

    // 3. Connection IDs & Reference IDs
    for (const conn of doc.payload.connections) {
      expect(conn.id).toMatch(UUID_REGEX);
      expect(conn.terminalIdA).toMatch(UUID_REGEX);
      expect(conn.terminalIdB).toMatch(UUID_REGEX);
    }
    for (const conn of doc.payload.noteConnections) {
      expect(conn.id).toMatch(UUID_REGEX);
      expect(conn.terminalId).toMatch(UUID_REGEX);
      expect(conn.noteNodeId).toMatch(UUID_REGEX);
    }
    for (const conn of doc.payload.portalConnections) {
      expect(conn.id).toMatch(UUID_REGEX);
      expect(conn.terminalId).toMatch(UUID_REGEX);
      expect(conn.portalNodeId).toMatch(UUID_REGEX);
    }
    for (const conn of doc.payload.portalToPortalConnections) {
      expect(conn.id).toMatch(UUID_REGEX);
      expect(conn.portalIdA).toMatch(UUID_REGEX);
      expect(conn.portalIdB).toMatch(UUID_REGEX);
    }
    for (const conn of doc.payload.noteToNoteConnections) {
      expect(conn.id).toMatch(UUID_REGEX);
      expect(conn.noteNodeIdA).toMatch(UUID_REGEX);
      expect(conn.noteNodeIdB).toMatch(UUID_REGEX);
    }
    for (const conn of doc.payload.crossFloorConnections) {
      expect(conn.id).toMatch(UUID_REGEX);
      expect(conn.nodeIdA).toMatch(UUID_REGEX);
      expect(conn.nodeIdB).toMatch(UUID_REGEX);
      if (conn.floorIdB) expect(conn.floorIdB).toMatch(UUID_REGEX);
    }

    // 4. Floors & Drawings IDs
    for (const floor of doc.payload.floors) {
      expect(floor.id).toMatch(UUID_REGEX);
    }
    for (const drawing of doc.payload.drawings) {
      expect(drawing.id).toMatch(UUID_REGEX);
    }
  });

  it("parses macOS v2 comprehensive golden fixture with all 8 node types, 6 connection types, floors, drawings, and unknown fields", async () => {
    const goldenFixture = await import("../../tests/fixtures/macOS_v2_comprehensive_golden_workspace.json");
    const doc = parseWorkspaceDocument(goldenFixture.default);

    expect(doc.schemaVersion).toBe(2);
    expect(doc.type).toBe("workspace");
    expect((doc as unknown as Record<string, unknown>).customDocumentMeta).toBe("macOS-v2-golden-root-meta");
    expect((doc.payload as unknown as Record<string, unknown>).customPayloadMeta).toEqual({
      engine: "swift-codable-v2",
      experimentalFlag: true,
    });

    // 12 nodes
    expect(doc.payload.nodes).toHaveLength(12);

    // Node content variant verification
    const contentVariants = doc.payload.nodes.map((node) => Object.keys(node.content)[0]);
    expect(contentVariants).toEqual([
      "terminal",
      "terminal",
      "stickyNote",
      "stickyNote",
      "portal",
      "portal",
      "fileTree",
      "text",
      "shape",
      "stroke",
      "freehand",
      "text",
    ]);

    // Unknown field preservation on node & content
    const termNode = doc.payload.nodes[0];
    expect((termNode as unknown as Record<string, unknown>).customNodeMeta).toBe("term-node-attr");
    if ("terminal" in termNode.content) {
      expect((termNode.content.terminal._0 as unknown as Record<string, unknown>).customTerminalField).toBe("agent-extra");
    }

    // Legacy node missing optional fields defaults
    const legacyNode = doc.payload.nodes[11];
    expect(legacyNode.zIndex).toBe(0);
    expect(legacyNode.isLocked).toBe(false);
    expect(legacyNode.lastModifiedAt).toBeDefined();

    // 6 Connection types verification
    expect(doc.payload.connections).toHaveLength(1);
    expect(doc.payload.noteConnections).toHaveLength(1);
    expect(doc.payload.portalConnections).toHaveLength(1);
    expect(doc.payload.portalToPortalConnections).toHaveLength(1);
    expect(doc.payload.noteToNoteConnections).toHaveLength(1);
    expect(doc.payload.crossFloorConnections).toHaveLength(1);

    expect((doc.payload.connections[0] as unknown as Record<string, unknown>).customConnAttr).toBe("t2t-rope");
    expect((doc.payload.crossFloorConnections[0] as unknown as Record<string, unknown>).customCrossFloorMeta).toBe("floor-bridge");

    // Floors & Drawings
    expect(doc.payload.floors).toHaveLength(1);
    expect((doc.payload.floors[0] as unknown as Record<string, unknown>).customFloorAttr).toBe("floor-extra");
    expect(doc.payload.drawings).toHaveLength(1);
    expect((doc.payload.drawings[0] as unknown as Record<string, unknown>).customDrawingAttr).toBe("hand-drawn-circle");
  });

  it("parses macOS v2 floors derived fixture, validates FloorEntry, FloorHooks, absent floorIdA for Ground, and unknown fields", async () => {
    const floorsFixture = await import("../../tests/fixtures/macOS_v2_floors_workspace.json");
    const doc = parseWorkspaceDocument(floorsFixture.default);

    const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

    expect(doc.schemaVersion).toBe(2);
    expect(doc.type).toBe("workspace");

    // Root & payload unknown fields
    expect((doc as unknown as Record<string, unknown>).customDocumentMeta).toBe("macOS-v2-floors-root-meta");
    expect((doc.payload as unknown as Record<string, unknown>).customPayloadMeta).toEqual({ floorEngine: "swift-v2" });

    // Floors validation with exact .open-maestri/floors/<name> path
    expect(doc.payload.floors).toHaveLength(1);
    const floor = doc.payload.floors[0];
    expect(floor.id).toMatch(UUID_REGEX);
    expect(floor.name).toBe("Feature Branch Floor");
    expect(floor.branchName).toBe("feat/mac-win-compat");
    expect(floor.worktreePath).toBe("/Users/maestri/projects/open-maestri/.open-maestri/floors/Feature Branch Floor");
    expect(floor.createdAt).toBe("2026-05-16T10:15:00.000Z");

    // FloorHooks validation & unknown field preservation
    expect(floor.hooks.setup).toEqual(["git status", "npm install"]);
    expect(floor.hooks.run).toEqual(["npm test"]);
    expect(floor.hooks.teardown).toEqual(["echo cleanup"]);
    expect(floor.hooks.autoRunSetup).toBe(true);
    expect((floor.hooks as unknown as Record<string, unknown>).customHookMeta).toBe("extra-hook-field");
    expect((floor as unknown as Record<string, unknown>).customFloorMeta).toBe("floor-attr");

    // CrossFloorConnection validation: Ground Floor is represented by ABSENCE of floorIdA (undefined)
    expect(doc.payload.crossFloorConnections).toHaveLength(1);
    const crossConn = doc.payload.crossFloorConnections[0];
    expect(crossConn.id).toMatch(UUID_REGEX);
    expect(crossConn.nodeIdA).toMatch(UUID_REGEX);
    expect(crossConn.floorIdA).toBeUndefined(); // Ground floor absent Optional nil
    expect(crossConn.nodeIdB).toMatch(UUID_REGEX);
    expect(crossConn.floorIdB).toBe("60000000-0000-0000-0000-000000000001");
    expect((crossConn as unknown as Record<string, unknown>).customCrossFloorMeta).toBe("floor-bridge");

    // CanvasNode MUST NOT contain floorId
    for (const node of doc.payload.nodes) {
      expect((node as unknown as Record<string, unknown>).floorId).toBeUndefined();
    }
  });

  it("normalizes FloorHooks defaults and filters string arrays when given partial or invalid inputs without erasing unknown fields", () => {
    const rawDoc = {
      schemaVersion: 2,
      type: "workspace",
      payload: {
        id: "10000000-0000-0000-0000-000000000003",
        name: "Partial Hooks Workspace",
        workingDirectory: "/tmp",
        canvasOrigin: { x: 0, y: 0 },
        canvasZoom: 1.0,
        nodes: [],
        connections: [],
        floors: [
          {
            id: "60000000-0000-0000-0000-000000000009",
            name: "Partial Floor",
            branchName: "main",
            worktreePath: "/tmp/partial",
            hooks: {
              setup: ["echo hello", 123, null], // array with non-strings to filter out
              onEnter: "git status", // legacy/custom field
            },
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
        createdAt: "2026-01-01T00:00:00Z",
        lastModifiedAt: "2026-01-01T00:00:00Z",
      },
    };

    const doc = parseWorkspaceDocument(rawDoc);
    const hooks = doc.payload.floors[0].hooks;
    expect(hooks.setup).toEqual(["echo hello"]);
    expect(hooks.run).toEqual([]);
    expect(hooks.teardown).toEqual([]);
    expect(hooks.autoRunSetup).toBe(false);
    expect((hooks as unknown as Record<string, unknown>).onEnter).toBe("git status");
  });

  it("performs complete TypeScript parse and exact JSON round-trip on floors fixture without data loss", async () => {
    const floorsFixture = await import("../../tests/fixtures/macOS_v2_floors_workspace.json");
    const originalDoc = parseWorkspaceDocument(floorsFixture.default);
    const serializedJson = JSON.stringify(originalDoc);
    const reParsedDoc = parseWorkspaceDocument(JSON.parse(serializedJson));

    expect(reParsedDoc).toEqual(originalDoc);
  });

  it("performs complete TypeScript parse and JSON round-trip on comprehensive golden fixture without data loss", async () => {
    const goldenFixture = await import("../../tests/fixtures/macOS_v2_comprehensive_golden_workspace.json");
    const originalDoc = parseWorkspaceDocument(goldenFixture.default);
    const serializedJson = JSON.stringify(originalDoc);
    const reParsedDoc = parseWorkspaceDocument(JSON.parse(serializedJson));

    expect(reParsedDoc).toEqual(originalDoc);
  });
});
