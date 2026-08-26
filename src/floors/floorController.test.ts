import { describe, expect, it, vi } from "vitest";
import { defaultFloorBridge, FloorBridge } from "../lib/floorBridge";
import { FloorController } from "./floorController";
import type { FloorEntry } from "../model/workspace";

function makeFakeFloor(id: string, name: string, branchName: string): FloorEntry {
  return {
    id,
    name,
    branchName,
    worktreePath: `C:\\Repo\\.open-maestri\\floors\\${name}`,
    hooks: { setup: [], run: [], teardown: [], autoRunSetup: false },
    createdAt: "2026-08-26T10:00:00.000Z",
  };
}

function makeFakeBridge(overrides?: Partial<FloorBridge>): FloorBridge {
  return {
    currentBranch: vi.fn().mockResolvedValue("main"),
    createFloor: vi.fn().mockImplementation(async (name, branchName) => makeFakeFloor("f-1", name, branchName)),
    removeFloor: vi.fn().mockResolvedValue(undefined),
    runHooks: vi.fn().mockResolvedValue(undefined),
    previewLand: vi.fn().mockResolvedValue("1 commit ready to land"),
    land: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("FloorBridge Browser Preview Contract", () => {
  it("lança erro explicito de indisponibilidade quando fora do app Tauri desktop (window.__TAURI_INTERNALS__ indef)", async () => {
    await expect(defaultFloorBridge.currentBranch("C:\\Repo")).rejects.toThrow(
      "Operaçoes de Floor (git worktree) estao disponiveis apenas no app desktop native (Tauri)."
    );
    await expect(defaultFloorBridge.createFloor("feat1", "feat-branch", "C:\\Repo")).rejects.toThrow(
      "Operaçoes de Floor (git worktree) estao disponiveis apenas no app desktop native (Tauri)."
    );
    await expect(defaultFloorBridge.removeFloor(makeFakeFloor("1", "f1", "b1"), "C:\\Repo")).rejects.toThrow(
      "Operaçoes de Floor (git worktree) estao disponiveis apenas no app desktop native (Tauri)."
    );
    await expect(defaultFloorBridge.runHooks(["echo 1"], makeFakeFloor("1", "f1", "b1"), "C:\\Repo")).rejects.toThrow(
      "Operaçoes de Floor (git worktree) estao disponiveis apenas no app desktop native (Tauri)."
    );
    await expect(defaultFloorBridge.previewLand(makeFakeFloor("1", "f1", "b1"), "main", "C:\\Repo")).rejects.toThrow(
      "Operaçoes de Floor (git worktree) estao disponiveis apenas no app desktop native (Tauri)."
    );
    await expect(defaultFloorBridge.land(makeFakeFloor("1", "f1", "b1"), "main", "C:\\Repo")).rejects.toThrow(
      "Operaçoes de Floor (git worktree) estao disponiveis apenas no app desktop native (Tauri)."
    );
  });
});

describe("FloorController Suite", () => {
  it("cria Floor com sucesso e atualiza a lista somente apos o retorno do backend", async () => {
    let resolveCreate: (val: FloorEntry) => void = () => {};
    const createPromise = new Promise<FloorEntry>((res) => {
      resolveCreate = res;
    });

    const bridge = makeFakeBridge({
      createFloor: vi.fn().mockReturnValue(createPromise),
    });

    const controller = new FloorController({ bridge });
    expect(controller.getFloors()).toEqual([]);

    const pendingCreate = controller.createFloor({
      name: "Feature-A",
      branchName: "feat/a",
      workingDirectory: "C:\\Repo",
    });

    // Sem mutacao otimista: lista permanece vazia enquanto o backend processa
    expect(controller.getFloors()).toEqual([]);
    expect(controller.isBusy("createFloor:Feature-A")).toBe(true);

    const created = makeFakeFloor("id-100", "Feature-A", "feat/a");
    resolveCreate(created);

    const result = await pendingCreate;
    expect(result).toEqual(created);
    expect(controller.getFloors()).toEqual([created]);
    expect(controller.isBusy()).toBe(false);
  });

  it("trata rejeicao no backend sem atualizar lista e mantem erro acionavel no controller", async () => {
    const bridge = makeFakeBridge({
      createFloor: vi.fn().mockRejectedValue(new Error("Git worktree failed: branch already exists")),
    });

    const controller = new FloorController({ bridge });

    await expect(
      controller.createFloor({
        name: "Feature-B",
        branchName: "feat/b",
        workingDirectory: "C:\\Repo",
      })
    ).rejects.toThrow("Git worktree failed: branch already exists");

    expect(controller.getFloors()).toEqual([]);
    expect(controller.getLastError()).toBe("Git worktree failed: branch already exists");
    expect(controller.isBusy()).toBe(false);
  });

  it("bloqueia chamadas concorrentes / double-submit para a mesma operacao", async () => {
    let resolveCurrentBranch: (b: string) => void = () => {};
    const bridge = makeFakeBridge({
      currentBranch: vi.fn().mockImplementation(
        () => new Promise((res) => { resolveCurrentBranch = res; })
      ),
    });

    const controller = new FloorController({ bridge });
    const p1 = controller.getCurrentBranch("C:\\Repo");

    await expect(controller.getCurrentBranch("C:\\Repo")).rejects.toThrow(
      "Operacao em andamento: currentBranch:C:\\Repo"
    );

    resolveCurrentBranch("main");
    await expect(p1).resolves.toBe("main");
  });

  it("remocao de Floor aguarda confirmacao do backend sem mutacao otimista", async () => {
    let resolveRemove: () => void = () => {};
    const bridge = makeFakeBridge({
      removeFloor: vi.fn().mockImplementation(
        () => new Promise((res) => { resolveRemove = res; })
      ),
    });

    const initialFloor = makeFakeFloor("f-1", "Feature-1", "feat/1");
    const controller = new FloorController({ bridge, initialFloors: [initialFloor] });

    const pRemove = controller.removeFloor({
      floor: initialFloor,
      workingDirectory: "C:\\Repo",
    });

    // Floor ainda presente na lista enquanto backend processa
    expect(controller.getFloors()).toEqual([initialFloor]);

    resolveRemove();
    await pRemove;

    // Apos sucesso, lista e atualizada
    expect(controller.getFloors()).toEqual([]);
  });

  it("executa landing e previewLand chamando o bridge sem alterar estado indevido", async () => {
    const bridge = makeFakeBridge({
      previewLand: vi.fn().mockResolvedValue("Clean merge available"),
      land: vi.fn().mockResolvedValue(undefined),
    });

    const floor = makeFakeFloor("f-1", "Feature-1", "feat/1");
    const controller = new FloorController({ bridge, initialFloors: [floor] });

    const preview = await controller.previewLand({
      floor,
      targetBranch: "main",
      workingDirectory: "C:\\Repo",
    });
    expect(preview).toBe("Clean merge available");
    expect(bridge.previewLand).toHaveBeenCalledWith(floor, "main", "C:\\Repo");

    await controller.land({
      floor,
      targetBranch: "main",
      workingDirectory: "C:\\Repo",
    });
    expect(bridge.land).toHaveBeenCalledWith(floor, "main", "C:\\Repo");
  });

  it("permite retry apos falha de operacao", async () => {
    let callCount = 0;
    const bridge = makeFakeBridge({
      createFloor: vi.fn().mockImplementation(async (name, branch) => {
        callCount++;
        if (callCount === 1) throw new Error("Network timeout");
        return makeFakeFloor("f-2", name, branch);
      }),
    });

    const controller = new FloorController({ bridge });

    await expect(
      controller.createFloor({ name: "RetryFloor", branchName: "feat/retry", workingDirectory: "C:\\Repo" })
    ).rejects.toThrow("Network timeout");

    expect(controller.getLastError()).toBe("Network timeout");
    expect(controller.isBusy()).toBe(false);

    // Tentativa 2 (retry)
    const floor = await controller.createFloor({
      name: "RetryFloor",
      branchName: "feat/retry",
      workingDirectory: "C:\\Repo",
    });
    expect(floor.name).toBe("RetryFloor");
    expect(controller.getFloors()).toHaveLength(1);
    expect(controller.getLastError()).toBeNull();
  });
});
