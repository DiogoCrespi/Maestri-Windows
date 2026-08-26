import { describe, expect, it, vi } from "vitest";
import {
  slugifyBranchName,
  validateCreateFloorInput,
  validateFloorHooks,
  selectFloorId,
  filterFloorsList,
  createDoubleSubmitGuard,
  type FloorItem,
  type FloorHooks,
} from "./index";

const mockHooks: FloorHooks = {
  setup: ["npm install", "  "],
  run: ["npm test"],
  teardown: ["echo teardown"],
  autoRunSetup: true,
};

const mockFloors: FloorItem[] = [
  {
    id: "floor-1",
    name: "Feature Login",
    branchName: "feat/login",
    hooks: mockHooks,
  },
  {
    id: "floor-2",
    name: "Fix Canvas",
    branchName: "fix/canvas-bug",
    hooks: { setup: [], run: [], teardown: [], autoRunSetup: false },
  },
];

describe("Floor UI Helpers - Branch Slugification & Validation", () => {
  it("slugifies floor names into valid git branch names", () => {
    expect(slugifyBranchName("Fix Login Bug!")).toBe("fix-login-bug");
    expect(slugifyBranchName("Feature User Profile")).toBe("feature-user-profile");
    expect(slugifyBranchName("feat/user-profile")).toBe("feat/user-profile");
    expect(slugifyBranchName("  My  Branch  ")).toBe("my-branch");
    expect(slugifyBranchName("feat_custom-123")).toBe("feat_custom-123");
  });

  it("validates floor creation inputs correctly", () => {
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
        branchName: "   ",
        useExistingBranch: false,
      }),
    ).toEqual({ isValid: false, error: "Nome da branch não pode ser vazio" });

    expect(
      validateCreateFloorInput({
        name: "Feature Login",
        branchName: "bad branch name!",
        useExistingBranch: false,
      }),
    ).toEqual({ isValid: false, error: "Nome da branch contém caracteres inválidos" });
  });

  it("cleans and validates floor hooks configuration", () => {
    const result = validateFloorHooks(mockHooks);
    expect(result.isValid).toBe(true);
    expect(result.cleaned).toEqual({
      setup: ["npm install"],
      run: ["npm test"],
      teardown: ["echo teardown"],
      autoRunSetup: true,
    });
  });

  it("handles floor selection transitions (Ground vs specific Floor)", () => {
    expect(selectFloorId("floor-1", "ground")).toBeNull();
    expect(selectFloorId(null, "floor-2")).toBe("floor-2");
    expect(selectFloorId("floor-2", null)).toBeNull();
  });

  it("filters floors list by search query", () => {
    expect(filterFloorsList(mockFloors, "")).toHaveLength(2);
    expect(filterFloorsList(mockFloors, "login")).toHaveLength(1);
    expect(filterFloorsList(mockFloors, "login")[0].id).toBe("floor-1");
    expect(filterFloorsList(mockFloors, "fix/canvas")).toHaveLength(1);
    expect(filterFloorsList(mockFloors, "nonexistent")).toHaveLength(0);
  });
});

describe("Floor UI Guard - Double Submit Protection", () => {
  it("prevents duplicate executions while async submit is in progress", async () => {
    const guard = createDoubleSubmitGuard();
    expect(guard.isBusy).toBe(false);

    let resolveAction: () => void = () => {};
    const mockAction = vi.fn().mockImplementation(
      () => new Promise<string>((res) => {
        resolveAction = () => res("done");
      }),
    );

    // First call initiates task
    const promise1 = guard.tryExecute(mockAction);
    expect(guard.isBusy).toBe(true);
    expect(mockAction).toHaveBeenCalledTimes(1);

    // Concurrent second call is blocked by guard
    const promise2 = guard.tryExecute(mockAction);
    expect(await promise2).toBeUndefined();
    expect(mockAction).toHaveBeenCalledTimes(1);

    resolveAction();
    expect(await promise1).toBe("done");
    expect(guard.isBusy).toBe(false);
  });
});
