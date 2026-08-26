import { invoke } from "@tauri-apps/api/core";
import type { FloorEntry } from "../model/workspace";

export interface FloorHooks {
  setup: string[];
  run: string[];
  teardown: string[];
  autoRunSetup: boolean;
}

export interface LandPreview {
  floorName: string;
  floorBranch: string;
  targetBranch: string;
  diffStat: string;
}

export type HookType = "setup" | "run" | "teardown";

export interface FloorBridge {
  currentBranch: (rootPath: string) => Promise<string>;
  createFloor: (
    rootPath: string,
    name: string,
    branchName: string,
    useExistingBranch?: boolean,
    hooks?: FloorHooks
  ) => Promise<FloorEntry>;
  removeFloor: (rootPath: string, floor: FloorEntry, deleteBranch?: boolean) => Promise<void>;
  runHooks: (rootPath: string, floor: FloorEntry, hookType: HookType) => Promise<void>;
  previewLand: (rootPath: string, floor: FloorEntry, targetBranch: string) => Promise<LandPreview>;
  land: (rootPath: string, floor: FloorEntry, targetBranch: string) => Promise<void>;
}

function checkIsNative(): boolean {
  return (
    typeof window !== "undefined" &&
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== undefined
  );
}

const BROWSER_UNAVAILABLE_ERROR =
  "Operaçoes de Floor (git worktree) estao disponiveis apenas no app desktop native (Tauri).";

export const defaultFloorBridge: FloorBridge = {
  async currentBranch(rootPath: string) {
    if (!checkIsNative()) {
      throw new Error(BROWSER_UNAVAILABLE_ERROR);
    }
    return invoke<string>("floor_current_branch", { rootPath });
  },

  async createFloor(
    rootPath: string,
    name: string,
    branchName: string,
    useExistingBranch?: boolean,
    hooks?: FloorHooks
  ) {
    if (!checkIsNative()) {
      throw new Error(BROWSER_UNAVAILABLE_ERROR);
    }
    return invoke<FloorEntry>("floor_create", {
      rootPath,
      name,
      branchName,
      useExistingBranch: useExistingBranch ?? false,
      hooks: hooks ?? { setup: [], run: [], teardown: [], autoRunSetup: false },
    });
  },

  async removeFloor(rootPath: string, floor: FloorEntry, deleteBranch?: boolean) {
    if (!checkIsNative()) {
      throw new Error(BROWSER_UNAVAILABLE_ERROR);
    }
    await invoke("floor_remove", { rootPath, floor, deleteBranch: deleteBranch ?? false });
  },

  async runHooks(rootPath: string, floor: FloorEntry, hookType: HookType) {
    if (!checkIsNative()) {
      throw new Error(BROWSER_UNAVAILABLE_ERROR);
    }
    await invoke("floor_run_hooks", { rootPath, floor, hookType });
  },

  async previewLand(rootPath: string, floor: FloorEntry, targetBranch: string) {
    if (!checkIsNative()) {
      throw new Error(BROWSER_UNAVAILABLE_ERROR);
    }
    return invoke<LandPreview>("floor_preview_land", { rootPath, floor, targetBranch });
  },

  async land(rootPath: string, floor: FloorEntry, targetBranch: string) {
    if (!checkIsNative()) {
      throw new Error(BROWSER_UNAVAILABLE_ERROR);
    }
    await invoke("floor_land", { rootPath, floor, targetBranch });
  },
};
