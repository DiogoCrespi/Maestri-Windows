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

  it("parses macOS v2 golden fixture with all 8 node types, 6 connection types, floors, drawings, and unknown fields", async () => {
    const goldenFixture = await import("../../tests/fixtures/macOS_v2_golden_workspace.json");
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

  it("performs complete Mac -> Windows -> Mac JSON round-trip on golden fixture without data loss", async () => {
    const goldenFixture = await import("../../tests/fixtures/macOS_v2_golden_workspace.json");
    const originalDoc = parseWorkspaceDocument(goldenFixture.default);
    const serializedJson = JSON.stringify(originalDoc);
    const reParsedDoc = parseWorkspaceDocument(JSON.parse(serializedJson));

    expect(reParsedDoc).toEqual(originalDoc);
  });
});

