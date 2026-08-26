import { describe, expect, it, vi } from "vitest";
import {
  slugifyBranchName,
  validateCreateFloorInput,
  sanitizeFloorHooks,
  FloorOperationController,
  type FloorItem,
  type FloorHooks,
} from "./index";

const mockHooksWithMeta: FloorHooks = {
  setup: ["npm install"],
  run: ["npm test"],
  teardown: ["echo teardown"],
  autoRunSetup: true,
  customHookMeta: "extra_val_123",
  customVersion: 2,
};

const mockFloors: FloorItem[] = [
  {
    id: "floor-1",
    name: "Feature Login",
    branchName: "feat/login",
    worktreePath: "C:\\Nestjs\\open-maestri\\.worktrees\\win-floor-1",
    createdAt: "2026-08-26T00:00:00.000Z",
    hooks: mockHooksWithMeta,
  },
  {
    id: "floor-2",
    name: "Fix Canvas",
    branchName: "fix/canvas-bug",
    worktreePath: "C:\\Nestjs\\open-maestri\\.worktrees\\win-floor-2",
    createdAt: "2026-08-26T01:00:00.000Z",
    hooks: { setup: [], run: [], teardown: [], autoRunSetup: false },
  },
];

describe("Floor Operation Controller & Double Submit Guard", () => {
  it("executes async operations successfully and notifies state changes", async () => {
    const controller = new FloorOperationController();
    const stateChanges: Array<{ isSubmitting: boolean; error: string | null }> = [];

    const op = vi.fn().mockResolvedValue("created-floor-id");
    const res = await controller.runOperation(op, (s) => stateChanges.push({ ...s }));

    expect(res).toEqual({ success: true, result: "created-floor-id" });
    expect(op).toHaveBeenCalledTimes(1);
    expect(stateChanges).toEqual([
      { isSubmitting: true, error: null },
      { isSubmitting: false, error: null },
    ]);
  });

  it("captures async rejections without unhandled promises and sets error state", async () => {
    const controller = new FloorOperationController();
    const stateChanges: Array<{ isSubmitting: boolean; error: string | null }> = [];

    const failingOp = vi.fn().mockRejectedValue(new Error("Git worktree creation failed"));
    const res = await controller.runOperation(failingOp, (s) => stateChanges.push({ ...s }));

    expect(res).toEqual({ success: false, error: "Git worktree creation failed" });
    expect(controller.error).toBe("Git worktree creation failed");
    expect(stateChanges).toEqual([
      { isSubmitting: true, error: null },
      { isSubmitting: false, error: "Git worktree creation failed" },
    ]);
  });

  it("blocks concurrent double-submit attempts while an operation is in flight", async () => {
    const controller = new FloorOperationController();
    let resolveFirst: (val: string) => void = () => {};

    const slowOp = vi.fn().mockImplementation(
      () => new Promise<string>((res) => { resolveFirst = res; }),
    );

    const promise1 = controller.runOperation(slowOp);
    expect(controller.isSubmitting).toBe(true);

    // Second call attempted while first is in flight
    const promise2 = controller.runOperation(slowOp);
    const res2 = await promise2;

    expect(res2).toEqual({ success: false, error: "Operação já em andamento" });
    expect(slowOp).toHaveBeenCalledTimes(1);

    resolveFirst("first-done");
    const res1 = await promise1;
    expect(res1).toEqual({ success: true, result: "first-done" });
    expect(controller.isSubmitting).toBe(false);
  });
});

describe("Floor Hooks - Preservation of Unknown Fields", () => {
  it("preserves custom unknown metadata fields when updating hooks", () => {
    const updated = sanitizeFloorHooks(mockHooksWithMeta, {
      run: ["npm run test:unit", "  "],
      autoRunSetup: false,
    });

    // Known fields are updated/sanitized
    expect(updated.run).toEqual(["npm run test:unit"]);
    expect(updated.autoRunSetup).toBe(false);
    expect(updated.setup).toEqual(["npm install"]);

    // Custom metadata is strictly preserved
    expect(updated.customHookMeta).toBe("extra_val_123");
    expect(updated.customVersion).toBe(2);
  });
});

describe("Branch Slugification & Validation Helpers", () => {
  it("slugifies floor names into valid git branch names", () => {
    expect(slugifyBranchName("Fix Login Bug!")).toBe("fix-login-bug");
    expect(slugifyBranchName("Feature User Profile")).toBe("feature-user-profile");
    expect(slugifyBranchName("feat/user-profile")).toBe("feat/user-profile");
  });

  it("validates floor creation inputs and rejects invalid inputs", () => {
    expect(
      validateCreateFloorInput({
        name: "Feature Login",
        branchName: "feat/login",
        useExistingBranch: false,
      }),
    ).toEqual({ isValid: true });

    expect(
      validateCreateFloorInput({
        name: "   ",
        branchName: "feat/login",
        useExistingBranch: false,
      }),
    ).toEqual({ isValid: false, error: "Nome do Floor não pode ser vazio" });

    expect(
      validateCreateFloorInput({
        name: "Feature Login",
        branchName: "bad branch name!",
        useExistingBranch: false,
      }),
    ).toEqual({ isValid: false, error: "Nome da branch contém caracteres inválidos" });
  });

  it("enforces required worktreePath and createdAt on FloorItem contract", () => {
    const item: FloorItem = mockFloors[0];
    expect(item.worktreePath).toBe("C:\\Nestjs\\open-maestri\\.worktrees\\win-floor-1");
    expect(item.createdAt).toBe("2026-08-26T00:00:00.000Z");
  });
});
