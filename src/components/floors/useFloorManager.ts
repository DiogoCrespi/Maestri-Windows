import { useState, useEffect, useMemo, useCallback } from "react";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { FloorController } from "../../floors/floorController";
import type { FloorEntry } from "../../model/workspace";
import type { FloorItem, CreateFloorInput, DeleteFloorInput, LandFloorInput, FloorHooks, HookPhase } from "./types";

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

  const controller = useMemo(
    () =>
      new FloorController({
        initialFloors: rawFloors,
        onFloorsChange: (updated) => {
          setFloorsInStore(updated);
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Silent sync store floors into controller to break feedback loop
  useEffect(() => {
    controller.setFloors(rawFloors, { silent: true });
  }, [controller, rawFloors]);

  // Fetch current branch for ground floor
  useEffect(() => {
    if (!workspaceDirectory) return;
    let active = true;
    controller
      .getCurrentBranch(workspaceDirectory)
      .then((branch) => {
        if (active) setGroundBranch(branch || "main");
      })
      .catch(() => {
        if (active) setGroundBranch("main");
      });
    return () => {
      active = false;
    };
  }, [controller, workspaceDirectory]);

  // Create Floor Handler - returns Promise<FloorEntry>
  const handleCreateFloor = useCallback(
    async (input: CreateFloorInput): Promise<FloorEntry> => {
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
        setIsCreateOpen(false);
        return created;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setErrorMessage(msg);
        throw err;
      } finally {
        setIsLoading(false);
      }
    },
    [controller, workspaceDirectory],
  );

  // Save Hooks Handler - returns Promise<void>
  const handleSaveHooks = useCallback(
    async (floorId: string, hooks: FloorHooks): Promise<void> => {
      setIsLoading(true);
      setErrorMessage(null);
      try {
        updateFloorHooksInStore(floorId, hooks as unknown as Record<string, unknown>);
        setHooksFloor(null);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setErrorMessage(msg);
        throw err;
      } finally {
        setIsLoading(false);
      }
    },
    [updateFloorHooksInStore],
  );

  // Run Hooks Handler - returns Promise<void>
  const handleRunHooks = useCallback(
    async (floor: FloorItem, phase: HookPhase): Promise<void> => {
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
        setErrorMessage(msg);
        throw err;
      } finally {
        setIsLoading(false);
      }
    },
    [controller, workspaceDirectory],
  );

  // Open Landing Dialog & Fetch Preview - returns Promise<void>
  const handleOpenLanding = useCallback(
    async (floor: FloorItem): Promise<void> => {
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
        setLandingDiffText(preview.diffStat || "Sem alterações pendentes.");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setLandingDiffText(`Erro ao carregar preview: ${msg}`);
      } finally {
        setIsLoadingDiff(false);
      }
    },
    [controller, groundBranch, workspaceDirectory],
  );

  // Perform Land Handler - returns Promise<void> (Removes floor ONLY after successful land)
  const handleLandFloor = useCallback(
    async (input: LandFloorInput): Promise<void> => {
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

        setLandingSuccess(true);
        setTimeout(() => {
          setLandingFloorTarget(null);
          setLandingSuccess(false);
        }, 1200);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setErrorMessage(msg);
        throw err;
      } finally {
        setIsLoading(false);
      }
    },
    [controller, landingFloorTarget, workspaceDirectory],
  );

  // Delete Floor Handler - returns Promise<void>
  const handleDeleteFloor = useCallback(
    async (input: DeleteFloorInput): Promise<void> => {
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
        setDeleteFloorTarget(null);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setErrorMessage(msg);
        throw err;
      } finally {
        setIsLoading(false);
      }
    },
    [controller, deleteFloorTarget, workspaceDirectory],
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
