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
});
