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

  it("ignora atualizações atrasadas (stale completion) quando o workspace ativo muda para B antes da conclusão", async () => {
    let resolveBridge: (f: FloorEntry) => void = () => {};
    const delayedPromise = new Promise<FloorEntry>((res) => {
      resolveBridge = res;
    });

    vi.mocked(defaultFloorBridge.createFloor).mockReturnValueOnce(delayedPromise);

    // Inicializa controller para Workspace A (id: "ws-1")
    const controllerA = new FloorController({
      initialFloors: [],
      onFloorsChange: (updated) => {
        const storeDoc = useWorkspaceStore.getState().currentDocument;
        if (!storeDoc || storeDoc.payload.id !== "ws-1") return;
        useWorkspaceStore.getState().setFloors(updated);
      },
    });

    const createOp = controllerA.createFloor({
      rootPath: "C:\\Nestjs\\open-maestri",
      name: "Floor Workspace A",
      branchName: "feat/ws-a",
    });

    // Antes do bridge responder, a aplicação troca o workspace ativo para Workspace B (id: "ws-2")
    const docB = {
      ...initialDoc,
      payload: {
        ...initialDoc.payload,
        id: "ws-2",
        name: "Workspace B",
        floors: [],
        lastModifiedAt: "2026-08-26T00:00:00.000Z",
      },
    };
    useWorkspaceStore.setState({
      currentDocument: docB,
      isDirty: false,
    });

    // Agora resolve a operação atrasada do Workspace A
    resolveBridge({
      id: "floor-ws-a",
      name: "Floor Workspace A",
      branchName: "feat/ws-a",
      worktreePath: "C:\\path\\ws-a",
      hooks: { setup: [], run: [], teardown: [], autoRunSetup: false },
      createdAt: "2026-08-26T00:00:00.000Z",
    });

    await createOp;

    // Workspace B deve permanecer INTACTO (floors vazios, isDirty: false, timestamp idêntico)
    const storeB = useWorkspaceStore.getState();
    expect(storeB.currentDocument?.payload.id).toBe("ws-2");
    expect(storeB.currentDocument?.payload.floors).toEqual([]);
    expect(storeB.isDirty).toBe(false);
    expect(storeB.currentDocument?.payload.lastModifiedAt).toBe("2026-08-26T00:00:00.000Z");
  });
});
