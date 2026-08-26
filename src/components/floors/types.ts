export interface FloorHooks {
  setup: string[];
  run: string[];
  teardown: string[];
  autoRunSetup: boolean;
  [key: string]: unknown;
}

export interface FloorItem {
  id: string;
  name: string;
  branchName: string;
  worktreePath: string;
  createdAt: string;
  hooks: FloorHooks;
  [key: string]: unknown;
}

export interface CreateFloorInput {
  name: string;
  branchName: string;
  useExistingBranch: boolean;
}

export interface DeleteFloorInput {
  floorId: string;
  keepBranch: boolean;
}

export type HookPhase = "setup" | "run" | "teardown";

export interface LandFloorInput {
  floorId: string;
  targetBranch: string;
}

export interface FloorOperationState {
  isSubmitting: boolean;
  error: string | null;
}
