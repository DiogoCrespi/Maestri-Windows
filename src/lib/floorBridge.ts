import { invoke } from "@tauri-apps/api/core";
import type { FloorEntry } from "../model/workspace";

export interface FloorHooks {
  setup: string[];
  run: string[];
  teardown: string[];
  autoRunSetup: boolean;
}

export interface FloorBridge {
  currentBranch: (workingDirectory: string) => Promise<string>;
  createFloor: (name: string, branchName: string, workingDirectory: string) => Promise<FloorEntry>;
  removeFloor: (floor: FloorEntry, workingDirectory: string) => Promise<void>;
  runHooks: (hooks: string[], floor: FloorEntry, workingDirectory: string) => Promise<void>;
  previewLand: (floor: FloorEntry, targetBranch: string, workingDirectory: string) => Promise<string>;
  land: (floor: FloorEntry, targetBranch: string, workingDirectory: string) => Promise<void>;
}

const isNative = typeof window !== "undefined" && (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== undefined;

const BROWSER_UNAVAILABLE_ERROR = "Operaçoes de Floor (git worktree) estao disponiveis apenas no app desktop native (Tauri).";

export const defaultFloorBridge: FloorBridge = {
  async currentBranch(workingDirectory: string) {
    if (!isNative) {
      throw new Error(BROWSER_UNAVAILABLE_ERROR);
    }
    return invoke<string>("floor_current_branch", { workingDirectory });
  },

  async createFloor(name: string, branchName: string, workingDirectory: string) {
    if (!isNative) {
      throw new Error(BROWSER_UNAVAILABLE_ERROR);
    }
    return invoke<FloorEntry>("floor_create", { name, branchName, workingDirectory });
  },

  async removeFloor(floor: FloorEntry, workingDirectory: string) {
    if (!isNative) {
      throw new Error(BROWSER_UNAVAILABLE_ERROR);
    }
    await invoke("floor_remove", { floor, workingDirectory });
  },

  async runHooks(hooks: string[], floor: FloorEntry, workingDirectory: string) {
    if (!isNative) {
      throw new Error(BROWSER_UNAVAILABLE_ERROR);
    }
    await invoke("floor_run_hooks", { hooks, floor, workingDirectory });
  },

  async previewLand(floor: FloorEntry, targetBranch: string, workingDirectory: string) {
    if (!isNative) {
      throw new Error(BROWSER_UNAVAILABLE_ERROR);
    }
    return invoke<string>("floor_preview_land", { floor, targetBranch, workingDirectory });
  },

  async land(floor: FloorEntry, targetBranch: string, workingDirectory: string) {
    if (!isNative) {
      throw new Error(BROWSER_UNAVAILABLE_ERROR);
    }
    await invoke("floor_land", { floor, targetBranch, workingDirectory });
  },
};
