import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { FloorController } from "../../floors/floorController";
import type { FloorEntry, WorkspaceDocument } from "../../model/workspace";
import type { FloorItem, CreateFloorInput, DeleteFloorInput, LandFloorInput, FloorHooks, HookPhase } from "./types";

export function updateFloorsForWorkspace(
  targetWorkspaceId: string | undefined,
  updatedFloors: FloorEntry[],
  currentDocument: WorkspaceDocument | null,
  setFloors: (floors: FloorEntry[], options?: { dirty?: boolean }) => void,
): boolean {
  if (!currentDocument || !targetWorkspaceId || currentDocument.payload.id !== targetWorkspaceId) {
    return false;
  }
  setFloors(updatedFloors);
  return true;
}

export function floorEntryToFloorItem(entry: FloorEntry): FloorItem {
  const rawHooks = (entry.hooks as unknown as FloorHooks) ?? { setup: [], run: [], teardown: [], autoRunSetup: false };
  const typedHooks: FloorHooks = {
    ...rawHooks,
    setup: Array.isArray(rawHooks.setup) ? rawHooks.setup : [],
    run: Array.isArray(rawHooks.run) ? rawHooks.run : [],
    teardown: Array.isArray(rawHooks.teardown) ? rawHooks.teardown : [],
    autoRunSetup: Boolean(rawHooks.autoRunSetup),
  };
  return {
    ...entry,
    hooks: typedHooks,
  };
}

export function floorItemToFloorEntry(item: FloorItem): FloorEntry {
  return {
    id: item.id,
    name: item.name,
    branchName: item.branchName,
    worktreePath: item.worktreePath,
    createdAt: item.createdAt,
    hooks: { ...item.hooks },
  };
}

export function useFloorManager(workspaceDirectory: string) {
  const currentDocument = useWorkspaceStore((state) => state.currentDocument);
  const currentWorkspaceId = currentDocument?.payload.id;
  const setFloorsInStore = useWorkspaceStore((state) => state.setFloors);
  const updateFloorHooksInStore = useWorkspaceStore((state) => state.updateFloorHooks);

  const rawFloors = useMemo(() => currentDocument?.payload.floors ?? [], [currentDocument?.payload.floors]);
  const floors: FloorItem[] = useMemo(() => rawFloors.map(floorEntryToFloorItem), [rawFloors]);

  const [selectedFloorId, setSelectedFloorId] = useState<string | null>(null);
  const [groundBranch, setGroundBranch] = useState<string>("main");
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Dialog State Management
  const [isOverviewOpen, setIsOverviewOpen] = useState(false);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [hooksFloor, setHooksFloor] = useState<FloorItem | null>(null);
  const [deleteFloorTarget, setDeleteFloorTarget] = useState<FloorItem | null>(null);
  const [landingFloorTarget, setLandingFloorTarget] = useState<FloorItem | null>(null);
  const [landingDiffText, setLandingDiffText] = useState<string>("");
  const [isLoadingDiff, setIsLoadingDiff] = useState<boolean>(false);
  const [landingSuccess, setLandingSuccess] = useState<boolean>(false);

  const activeWorkspaceRef = useRef({ id: currentWorkspaceId, dir: workspaceDirectory });
  useEffect(() => {
    activeWorkspaceRef.current = { id: currentWorkspaceId, dir: workspaceDirectory };
  }, [currentWorkspaceId, workspaceDirectory]);

  // Controller scoped strictly to stable workspace identity
  const controller = useMemo(() => {
    const boundWorkspaceId = currentWorkspaceId;
    return new FloorController({
      initialFloors: rawFloors,
      onFloorsChange: (updated) => {
        const storeDoc = useWorkspaceStore.getState().currentDocument;
        updateFloorsForWorkspace(boundWorkspaceId, updated, storeDoc, setFloorsInStore);
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentWorkspaceId, workspaceDirectory]);

  const locationType = useWorkspaceStore(
    (state) => state.currentDocument?.payload.locationType ?? "local",
  );
  const isSshLocation = locationType === "ssh";

  // Silent sync store floors into controller to break feedback loop
  useEffect(() => {
    controller.setFloors(rawFloors, { silent: true });
  }, [controller, rawFloors]);

  // Fetch current branch for ground floor
  useEffect(() => {
    if (!workspaceDirectory || isSshLocation) {
      if (isSshLocation) {
        setGroundBranch("remote-ssh");
      }
      return;
    }
    let active = true;
    controller
      .getCurrentBranch(workspaceDirectory)
      .then((branch) => {
        if (active && activeWorkspaceRef.current.id === currentWorkspaceId) {
          setGroundBranch(branch || "main");
        }
      })
      .catch(() => {
        if (active && activeWorkspaceRef.current.id === currentWorkspaceId) {
          setGroundBranch("main");
        }
      });
    return () => {
      active = false;
    };
  }, [controller, currentWorkspaceId, isSshLocation, workspaceDirectory]);

  // Create Floor Handler - returns Promise<FloorEntry>
  const handleCreateFloor = useCallback(
    async (input: CreateFloorInput): Promise<FloorEntry> => {
      if (isSshLocation) {
        const msg = "Operações de Work Floors (git worktree) não estão disponíveis para workspaces remotos (SSH)";
        setErrorMessage(msg);
        throw new Error(msg);
      }
      const activeId = currentWorkspaceId;
      if (!workspaceDirectory) throw new Error("Diretório de trabalho não definido");
      setIsLoading(true);
      setErrorMessage(null);
      try {
        const created = await controller.createFloor({
          rootPath: workspaceDirectory,
          name: input.name,
          branchName: input.branchName,
          useExistingBranch: input.useExistingBranch,
        });
        updateFloorsForWorkspace(
          currentWorkspaceId,
          [...rawFloors, created],
          useWorkspaceStore.getState().currentDocument,
          setFloorsInStore,
        );
        if (activeWorkspaceRef.current.id === activeId) {
          setIsCreateOpen(false);
        }
        return created;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (activeWorkspaceRef.current.id === activeId) {
          setErrorMessage(msg);
        }
        throw err;
      } finally {
        if (activeWorkspaceRef.current.id === activeId) {
          setIsLoading(false);
        }
      }
    },
    [controller, currentWorkspaceId, isSshLocation, rawFloors, setFloorsInStore, workspaceDirectory],
  );

  // Save Hooks Handler - returns Promise<void>
  const handleSaveHooks = useCallback(
    async (floorId: string, hooks: FloorHooks): Promise<void> => {
      const activeId = currentWorkspaceId;
      setIsLoading(true);
      setErrorMessage(null);
      try {
        if (activeWorkspaceRef.current.id === activeId) {
          updateFloorHooksInStore(floorId, hooks as unknown as Record<string, unknown>);
          setHooksFloor(null);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (activeWorkspaceRef.current.id === activeId) {
          setErrorMessage(msg);
        }
        throw err;
      } finally {
        if (activeWorkspaceRef.current.id === activeId) {
          setIsLoading(false);
        }
      }
    },
    [currentWorkspaceId, updateFloorHooksInStore],
  );

  // Run Hooks Handler - returns Promise<void>
  const handleRunHooks = useCallback(
    async (floor: FloorItem, phase: HookPhase): Promise<void> => {
      if (isSshLocation) {
        const msg = "Execução de hooks não está disponível para workspaces remotos (SSH)";
        setErrorMessage(msg);
        throw new Error(msg);
      }
      const activeId = currentWorkspaceId;
      if (!workspaceDirectory) return;
      setIsLoading(true);
      setErrorMessage(null);
      try {
        const entry = floorItemToFloorEntry(floor);
        await controller.runHooks({
          rootPath: workspaceDirectory,
          floor: entry,
          hookType: phase,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (activeWorkspaceRef.current.id === activeId) {
          setErrorMessage(msg);
        }
        throw err;
      } finally {
        if (activeWorkspaceRef.current.id === activeId) {
          setIsLoading(false);
        }
      }
    },
    [controller, currentWorkspaceId, workspaceDirectory],
  );

  // Open Landing Dialog & Fetch Preview - returns Promise<void>
  const handleOpenLanding = useCallback(
    async (floor: FloorItem): Promise<void> => {
      if (isSshLocation) {
        const msg = "Preview e Landing de Floors não estão disponíveis para workspaces remotos (SSH)";
        setErrorMessage(msg);
        return;
      }
      const activeId = currentWorkspaceId;
      setLandingFloorTarget(floor);
      setLandingDiffText("");
      setLandingSuccess(false);
      setIsLoadingDiff(true);
      setErrorMessage(null);
      try {
        const entry = floorItemToFloorEntry(floor);
        const preview = await controller.previewLand({
          rootPath: workspaceDirectory,
          floor: entry,
          targetBranch: groundBranch || "main",
        });
        if (activeWorkspaceRef.current.id === activeId) {
          setLandingDiffText(preview.diffStat || "Sem alterações pendentes.");
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (activeWorkspaceRef.current.id === activeId) {
          setLandingDiffText(`Erro ao carregar preview: ${msg}`);
        }
      } finally {
        if (activeWorkspaceRef.current.id === activeId) {
          setIsLoadingDiff(false);
        }
      }
    },
    [controller, currentWorkspaceId, groundBranch, isSshLocation, workspaceDirectory],
  );

  // Perform Land Handler - returns Promise<void> (Removes floor ONLY after successful land)
  const handleLandFloor = useCallback(
    async (input: LandFloorInput): Promise<void> => {
      if (isSshLocation) {
        const msg = "Landing de Floors não está disponível para workspaces remotos (SSH)";
        setErrorMessage(msg);
        throw new Error(msg);
      }
      const activeId = currentWorkspaceId;
      if (!landingFloorTarget || !workspaceDirectory) return;
      setIsLoading(true);
      setErrorMessage(null);
      try {
        const entry = floorItemToFloorEntry(landingFloorTarget);
        await controller.land({
          rootPath: workspaceDirectory,
          floor: entry,
          targetBranch: input.targetBranch,
        });

        // Backend land succeeded! NOW perform cleanup of floor entry
        await controller.removeFloor({
          rootPath: workspaceDirectory,
          floor: entry,
          deleteBranch: false,
        });

        if (activeWorkspaceRef.current.id === activeId) {
          setLandingSuccess(true);
          setTimeout(() => {
            if (activeWorkspaceRef.current.id === activeId) {
              setLandingFloorTarget(null);
              setLandingSuccess(false);
            }
          }, 1200);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (activeWorkspaceRef.current.id === activeId) {
          setErrorMessage(msg);
        }
        throw err;
      } finally {
        if (activeWorkspaceRef.current.id === activeId) {
          setIsLoading(false);
        }
      }
    },
    [controller, currentWorkspaceId, isSshLocation, landingFloorTarget, workspaceDirectory],
  );

  // Delete Floor Handler - returns Promise<void>
  const handleDeleteFloor = useCallback(
    async (input: DeleteFloorInput): Promise<void> => {
      if (isSshLocation) {
        const msg = "Remoção de Floors (git worktree) não está disponível para workspaces remotos (SSH)";
        setErrorMessage(msg);
        throw new Error(msg);
      }
      const activeId = currentWorkspaceId;
      if (!deleteFloorTarget || !workspaceDirectory) return;
      setIsLoading(true);
      setErrorMessage(null);
      try {
        const entry = floorItemToFloorEntry(deleteFloorTarget);
        await controller.removeFloor({
          rootPath: workspaceDirectory,
          floor: entry,
          deleteBranch: !input.keepBranch,
        });
        if (activeWorkspaceRef.current.id === activeId) {
          setDeleteFloorTarget(null);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (activeWorkspaceRef.current.id === activeId) {
          setErrorMessage(msg);
        }
        throw err;
      } finally {
        if (activeWorkspaceRef.current.id === activeId) {
          setIsLoading(false);
        }
      }
    },
    [controller, currentWorkspaceId, deleteFloorTarget, isSshLocation, workspaceDirectory],
  );

  return {
    floors,
    selectedFloorId,
    setSelectedFloorId,
    groundBranch,
    isLoading,
    errorMessage,
    setErrorMessage,
    isOverviewOpen,
    setIsOverviewOpen,
    isCreateOpen,
    setIsCreateOpen,
    hooksFloor,
    setHooksFloor,
    deleteFloorTarget,
    setDeleteFloorTarget,
    landingFloorTarget,
    setLandingFloorTarget,
    landingDiffText,
    isLoadingDiff,
    landingSuccess,
    handleCreateFloor,
    handleSaveHooks,
    handleRunHooks,
    handleOpenLanding,
    handleLandFloor,
    handleDeleteFloor,
  };
}
