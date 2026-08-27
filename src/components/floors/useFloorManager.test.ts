import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  useFloorManager,
  floorEntryToFloorItem,
  floorItemToFloorEntry,
  updateFloorsForWorkspace,
} from "./useFloorManager";
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
      onFloorsChange: (updated) => {
        const storeDoc = useWorkspaceStore.getState().currentDocument;
        updateFloorsForWorkspace("ws-1", updated, storeDoc, (floors, opts) =>
          useWorkspaceStore.getState().setFloors(floors, opts),
        );
      },
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
        const storeDoc = useWorkspaceStore.getState().currentDocument;
        updateFloorsForWorkspace("ws-1", updated, storeDoc, (floors, opts) =>
          useWorkspaceStore.getState().setFloors(floors, opts),
        );
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
      onFloorsChange: (updated) => {
        const storeDoc = useWorkspaceStore.getState().currentDocument;
        updateFloorsForWorkspace("ws-1", updated, storeDoc, (floors, opts) =>
          useWorkspaceStore.getState().setFloors(floors, opts),
        );
      },
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

  it("updateFloorsForWorkspace ignora atualizações para workspace inativo (stale completion) e atualiza o workspace ativo normalmente", () => {
    const docA = JSON.parse(JSON.stringify(initialDoc));
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

    const mockSetFloors = vi.fn();
    const updatedFloors: FloorEntry[] = [
      {
        id: "floor-ws-a",
        name: "Floor A",
        branchName: "feat/a",
        worktreePath: "C:\\path\\a",
        hooks: { setup: [], run: [], teardown: [], autoRunSetup: false },
        createdAt: "2026-08-26T00:00:00.000Z",
      },
    ];

    // 1. Chamada atrasada referente a Workspace A (targetWorkspaceId: "ws-1") quando o workspace ativo é Workspace B (docB)
    const resultStale = updateFloorsForWorkspace("ws-1", updatedFloors, docB, mockSetFloors);
    expect(resultStale).toBe(false);
    expect(mockSetFloors).not.toHaveBeenCalled();

    // 2. Chamada referente a Workspace A quando o workspace ativo é Workspace A (docA)
    const resultActive = updateFloorsForWorkspace("ws-1", updatedFloors, docA, mockSetFloors);
    expect(resultActive).toBe(true);
    expect(mockSetFloors).toHaveBeenCalledWith(updatedFloors);
  });

  it("bloqueia estritamente invocações de IPC nativo local quando locationType é ssh", async () => {
    const sshDoc = {
      ...initialDoc,
      payload: {
        ...initialDoc.payload,
        id: "ws-ssh",
        locationType: "ssh" as const,
      },
    };
    useWorkspaceStore.setState({ currentDocument: sshDoc });

    const controller = new FloorController({ initialFloors: [] });

    // Tentar criar floor em workspace SSH deve ser bloqueado ANTES do bridge
    await expect(
      controller.createFloor({
        rootPath: "user@host:/remote/dir",
        name: "RemoteFloor",
        branchName: "feat/remote",
      }),
    ).rejects.toThrow();

    expect(defaultFloorBridge.createFloor).not.toHaveBeenCalled();
    expect(defaultFloorBridge.currentBranch).not.toHaveBeenCalled();
    expect(defaultFloorBridge.runHooks).not.toHaveBeenCalled();
  });
});
