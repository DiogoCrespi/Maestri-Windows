export interface FloorHooks {
  setup: string[];
  run: string[];
  teardown: string[];
  autoRunSetup: boolean;
}

export interface FloorItem {
  id: string;
  name: string;
  branchName: string;
  worktreePath?: string;
  hooks: FloorHooks;
  createdAt?: string;
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

export interface LandFloorInput {
  floorId: string;
  targetBranch: string;
}
