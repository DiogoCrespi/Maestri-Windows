import { describe, it, expect, beforeEach, vi } from "vitest";
import { floorEntryToFloorItem, floorItemToFloorEntry } from "./useFloorManager";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { FloorController } from "../../floors/floorController";
import type { FloorEntry, FloorHooks } from "../../model/workspace";

vi.mock("../../lib/floorBridge", () => ({
  defaultFloorBridge: {
    createFloor: vi.fn(),
    removeFloor: vi.fn(),
    runHooks: vi.fn(),
    previewLand: vi.fn(),
    land: vi.fn(),
    currentBranch: vi.fn().mockResolvedValue("main"),
  },
}));

import { defaultFloorBridge } from "../../lib/floorBridge";

describe("useFloorManager & FloorController Integration Tests", () => {
  const initialDoc = {
    schemaVersion: 2,
    type: "workspace" as const,
    payload: {
      id: "ws-1",
      name: "Test Workspace",
      icon: "folder",
      isPinned: false,
      locationType: "local" as const,
      workingDirectory: "C:\\Nestjs\\open-maestri",
      preferredIDE: "cursor",
      syncConfigFiles: false,
      canvasOrigin: { x: 0, y: 0 },
      canvasZoom: 1,
      nodes: [],
      connections: [],
      noteConnections: [],
      portalConnections: [],
      portalToPortalConnections: [],
      noteToNoteConnections: [],
      crossFloorConnections: [],
      floors: [] as FloorEntry[],
      drawings: [],
      createdAt: "2026-08-26T00:00:00.000Z",
      lastModifiedAt: "2026-08-26T00:00:00.000Z",
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    useWorkspaceStore.setState({
      currentDocument: JSON.parse(JSON.stringify(initialDoc)),
      nodes: [],
      edges: [],
      isDirty: false,
    });
  });

  it("converts FloorEntry to FloorItem and back preserving custom fields", () => {
    const entry: FloorEntry = {
      id: "f-1",
      name: "Floor 1",
      branchName: "feat/f-1",
      worktreePath: "C:\\worktree",
      createdAt: "2026-08-26T00:00:00.000Z",
      hooks: { setup: ["npm i"], run: [], teardown: [], autoRunSetup: true, customHookMeta: "meta-val" } as unknown as FloorHooks,
    };

    const item = floorEntryToFloorItem(entry);
    expect(item.id).toBe("f-1");
    expect((item.hooks as unknown as Record<string, unknown>).customHookMeta).toBe("meta-val");

    const back = floorItemToFloorEntry(item);
    expect(back.id).toBe("f-1");
    expect((back.hooks as unknown as Record<string, unknown>).customHookMeta).toBe("meta-val");
  });

  it("syncs store floors silently without triggering dirty state or updating timestamp (no feedback loop)", () => {
    const docBefore = useWorkspaceStore.getState().currentDocument;
    const oldTimestamp = docBefore!.payload.lastModifiedAt;

    const controller = new FloorController({
      initialFloors: [],
      onFloorsChange: (updated) => useWorkspaceStore.getState().setFloors(updated),
    });

    // Perform silent sync
    controller.setFloors([], { silent: true });

    expect(useWorkspaceStore.getState().isDirty).toBe(false);
    expect(useWorkspaceStore.getState().currentDocument?.payload.lastModifiedAt).toBe(oldTimestamp);
  });

  it("createFloor returns a real Promise and updates store exactly once on success", async () => {
    const mockCreatedFloor: FloorEntry = {
      id: "floor-new",
      name: "New Floor",
      branchName: "feat/new",
      worktreePath: "C:\\path\\new",
      hooks: { setup: [], run: [], teardown: [], autoRunSetup: false },
      createdAt: "2026-08-26T00:00:00.000Z",
    };

    vi.mocked(defaultFloorBridge.createFloor).mockResolvedValueOnce(mockCreatedFloor);

    let onFloorsChangeCount = 0;
    const controller = new FloorController({
      initialFloors: [],
      onFloorsChange: (updated) => {
        onFloorsChangeCount++;
        useWorkspaceStore.getState().setFloors(updated);
      },
    });

    const createPromise = controller.createFloor({
      rootPath: "C:\\Nestjs\\open-maestri",
      name: "New Floor",
      branchName: "feat/new",
      useExistingBranch: false,
    });

    expect(createPromise).toBeInstanceOf(Promise);
    const created = await createPromise;

    expect(created.id).toBe("floor-new");
    expect(onFloorsChangeCount).toBe(1);

    const docFloors = useWorkspaceStore.getState().currentDocument?.payload.floors;
    expect(docFloors).toHaveLength(1);
    expect(docFloors?.[0].id).toBe("floor-new");
    expect(useWorkspaceStore.getState().isDirty).toBe(true);
  });

  it("preserves created floor when autoRunSetup fails during createFloor", async () => {
    const mockCreatedFloor: FloorEntry = {
      id: "floor-setup-fail",
      name: "Failed Setup Floor",
      branchName: "feat/fail",
      worktreePath: "C:\\path\\fail",
      hooks: { setup: ["broken-command"], run: [], teardown: [], autoRunSetup: true },
      createdAt: "2026-08-26T00:00:00.000Z",
    };

    vi.mocked(defaultFloorBridge.createFloor).mockResolvedValueOnce(mockCreatedFloor);
    vi.mocked(defaultFloorBridge.runHooks).mockRejectedValueOnce(new Error("Setup hook failed"));

    const controller = new FloorController({
      initialFloors: [],
      onFloorsChange: (updated) => useWorkspaceStore.getState().setFloors(updated),
    });

    await expect(
      controller.createFloor({
        rootPath: "C:\\Nestjs\\open-maestri",
        name: "Failed Setup Floor",
        branchName: "feat/fail",
      }),
    ).rejects.toThrow("Setup hook failed");

    // Created floor must be preserved in store despite autoRunSetup failure
    const docFloors = useWorkspaceStore.getState().currentDocument?.payload.floors;
    expect(docFloors).toHaveLength(1);
    expect(docFloors?.[0].id).toBe("floor-setup-fail");
  });

  it("createFloor rejects cleanly on bridge error", async () => {
    vi.mocked(defaultFloorBridge.createFloor).mockRejectedValueOnce(new Error("Branch name exists"));

    const controller = new FloorController({
      initialFloors: [],
      onFloorsChange: (updated) => useWorkspaceStore.getState().setFloors(updated),
    });

    await expect(
      controller.createFloor({
        rootPath: "C:\\Nestjs\\open-maestri",
        name: "Invalid Floor",
        branchName: "existing-branch",
        useExistingBranch: false,
      }),
    ).rejects.toThrow("Branch name exists");
  });
});
