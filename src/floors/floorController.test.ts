import { describe, expect, it, vi } from "vitest";
import * as core from "@tauri-apps/api/core";
import { defaultFloorBridge, FloorBridge, LandPreview } from "../lib/floorBridge";
import { FloorController } from "./floorController";
import type { FloorEntry } from "../model/workspace";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

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
    createFloor: vi.fn().mockImplementation(async (_root, name, branchName) => makeFakeFloor("f-1", name, branchName)),
    removeFloor: vi.fn().mockResolvedValue(undefined),
    runHooks: vi.fn().mockResolvedValue(undefined),
    previewLand: vi.fn().mockResolvedValue({
      floorName: "Feature-1",
      floorBranch: "feat/1",
      targetBranch: "main",
      diffStat: "1 file changed, 10 insertions(+)",
    }),
    land: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("defaultFloorBridge exact invoke signature & dynamic browser detection", () => {
  it("lança erro explicito no browser preview quando __TAURI_INTERNALS__ nao existe e re-avalia dinamicamente", async () => {
    delete (globalThis as unknown as { window?: { __TAURI_INTERNALS__?: unknown } }).window;

    await expect(defaultFloorBridge.currentBranch("C:\\Repo")).rejects.toThrow(
      "Operaçoes de Floor (git worktree) estao disponiveis apenas no app desktop native (Tauri)."
    );

    // Simula dinamica de injecao do Tauri no runtime sem recarregar modulo
    (globalThis as unknown as { window?: { __TAURI_INTERNALS__?: unknown } }).window = {
      __TAURI_INTERNALS__: {},
    };
    const invokeMock = vi.mocked(core.invoke);
    invokeMock.mockResolvedValueOnce("feature/native");

    const branch = await defaultFloorBridge.currentBranch("C:\\Repo");
    expect(branch).toBe("feature/native");
    expect(invokeMock).toHaveBeenCalledWith("floor_current_branch", { rootPath: "C:\\Repo" });

    // Limpa a marcacao para os proximos testes
    delete (globalThis as unknown as { window?: { __TAURI_INTERNALS__?: unknown } }).window;
  });

  it("garante envio dos nomes de invoke e argumentos exatos no ambiente nativo Tauri", async () => {
    (globalThis as unknown as { window?: { __TAURI_INTERNALS__?: unknown } }).window = {
      __TAURI_INTERNALS__: {},
    };
    const invokeMock = vi.mocked(core.invoke);
    invokeMock.mockClear();
    const floor = makeFakeFloor("id-99", "Floor-Native", "feat/native");

    invokeMock.mockResolvedValueOnce("main");
    await defaultFloorBridge.currentBranch("C:\\Project");
    expect(invokeMock).toHaveBeenLastCalledWith("floor_current_branch", { rootPath: "C:\\Project" });

    invokeMock.mockResolvedValueOnce(floor);
    await defaultFloorBridge.createFloor("C:\\Project", "Floor-Native", "feat/native", true, {
      setup: ["npm i"],
      run: ["npm test"],
      teardown: [],
      autoRunSetup: true,
    });
    expect(invokeMock).toHaveBeenLastCalledWith("floor_create", {
      rootPath: "C:\\Project",
      name: "Floor-Native",
      branchName: "feat/native",
      useExistingBranch: true,
      hooks: {
        setup: ["npm i"],
        run: ["npm test"],
        teardown: [],
        autoRunSetup: true,
      },
    });

    invokeMock.mockResolvedValueOnce(undefined);
    await defaultFloorBridge.removeFloor("C:\\Project", floor, true);
    expect(invokeMock).toHaveBeenLastCalledWith("floor_remove", {
      rootPath: "C:\\Project",
      floor,
      deleteBranch: true,
    });

    invokeMock.mockResolvedValueOnce(undefined);
    await defaultFloorBridge.runHooks("C:\\Project", floor, "setup");
    expect(invokeMock).toHaveBeenLastCalledWith("floor_run_hooks", {
      rootPath: "C:\\Project",
      floor,
      hookType: "setup",
    });

    const fakePreview: LandPreview = {
      floorName: "Floor-Native",
      floorBranch: "feat/native",
      targetBranch: "main",
      diffStat: "2 files changed",
    };
    invokeMock.mockResolvedValueOnce(fakePreview);
    const previewRes = await defaultFloorBridge.previewLand("C:\\Project", floor, "main");
    expect(previewRes).toEqual(fakePreview);
    expect(invokeMock).toHaveBeenLastCalledWith("floor_preview_land", {
      rootPath: "C:\\Project",
      floor,
      targetBranch: "main",
    });

    invokeMock.mockResolvedValueOnce(undefined);
    await defaultFloorBridge.land("C:\\Project", floor, "main");
    expect(invokeMock).toHaveBeenLastCalledWith("floor_land", {
      rootPath: "C:\\Project",
      floor,
      targetBranch: "main",
    });

    // Prova que NENHUM invoke com nomes/payloads antigos/errados foi realizado
    const calledCommandNames = invokeMock.mock.calls.map((call) => call[0]);
    expect(calledCommandNames).toEqual([
      "floor_current_branch",
      "floor_create",
      "floor_remove",
      "floor_run_hooks",
      "floor_preview_land",
      "floor_land",
    ]);

    delete (globalThis as unknown as { window?: { __TAURI_INTERNALS__?: unknown } }).window;
  });
});

describe("FloorController Core Logic & Concurrency", () => {
  it("cria Floor com sucesso repassando argumentos exatos ao bridge e atualizando lista", async () => {
    let resolveCreate!: (val: FloorEntry | PromiseLike<FloorEntry>) => void;
    const createPromise = new Promise<FloorEntry>((res) => {
      resolveCreate = res;
    });

    const bridge = makeFakeBridge({
      createFloor: vi.fn().mockReturnValue(createPromise),
    });

    const controller = new FloorController({ bridge });
    expect(controller.getFloors()).toEqual([]);

    const pendingCreate = controller.createFloor({
      rootPath: "C:\\Repo",
      name: "Feature-A",
      branchName: "feat/a",
      useExistingBranch: true,
    });

    expect(controller.getFloors()).toEqual([]);
    expect(controller.isBusy("createFloor:Feature-A")).toBe(true);

    const created = makeFakeFloor("id-100", "Feature-A", "feat/a");
    resolveCreate(created);

    const result = await pendingCreate;
    expect(result).toEqual(created);
    expect(controller.getFloors()).toEqual([created]);
    expect(bridge.createFloor).toHaveBeenCalledWith("C:\\Repo", "Feature-A", "feat/a", true, undefined);
    expect(controller.isBusy()).toBe(false);
  });

  it("usa createdFloor.hooks retornado pelo backend como fonte autoritativa em autoRunSetup", async () => {
    // Requisição frontend sem autoRunSetup, mas o backend normaliza e retorna com autoRunSetup=true
    const reqHooks = { setup: ["echo req"], run: [], teardown: [], autoRunSetup: false };
    const backendCreatedFloor = makeFakeFloor("f-auth", "AuthFloor", "feat/auth");
    backendCreatedFloor.hooks = { setup: ["echo backend"], run: [], teardown: [], autoRunSetup: true };

    const bridge = makeFakeBridge({
      createFloor: vi.fn().mockResolvedValue(backendCreatedFloor),
      runHooks: vi.fn().mockResolvedValue(undefined),
    });

    const controller = new FloorController({ bridge });
    await controller.createFloor({
      rootPath: "C:\\Repo",
      name: "AuthFloor",
      branchName: "feat/auth",
      hooks: reqHooks,
    });

    // Prova que o runHooks usou o comando e a flag autoritativa do backend ("echo backend")
    expect(bridge.runHooks).toHaveBeenCalledWith("C:\\Repo", backendCreatedFloor, "setup");
  });

  it("serializa operacoes de mutacao no mesmo workspace root normalizado (no maximo uma mutacao backend em voo)", async () => {
    const activeMutations: string[] = [];
    let maxConcurrentMutations = 0;

    let resolveFirstCreate!: (val: FloorEntry | PromiseLike<FloorEntry>) => void;
    const firstCreatePromise = new Promise<FloorEntry>((res) => {
      resolveFirstCreate = res;
    });

    let resolveRemove!: (val: void | PromiseLike<void>) => void;
    const removePromise = new Promise<void>((res) => {
      resolveRemove = res;
    });

    const floorToDel = makeFakeFloor("f-del", "FloorToDel", "feat/del");

    const bridge = makeFakeBridge({
      createFloor: vi.fn().mockImplementation((_root, name, branch) => {
        activeMutations.push(`create:${name}`);
        maxConcurrentMutations = Math.max(maxConcurrentMutations, activeMutations.length);
        if (name === "FirstFloor") {
          return firstCreatePromise.then((res) => {
            activeMutations.splice(activeMutations.indexOf(`create:${name}`), 1);
            return res;
          });
        }
        activeMutations.splice(activeMutations.indexOf(`create:${name}`), 1);
        return Promise.resolve(makeFakeFloor(`id-${name}`, name, branch));
      }),
      removeFloor: vi.fn().mockImplementation(() => {
        activeMutations.push(`remove:${floorToDel.name}`);
        maxConcurrentMutations = Math.max(maxConcurrentMutations, activeMutations.length);
        return removePromise.then(() => {
          activeMutations.splice(activeMutations.indexOf(`remove:${floorToDel.name}`), 1);
        });
      }),
      land: vi.fn().mockImplementation(async (_root, floor) => {
        activeMutations.push(`land:${floor.name}`);
        maxConcurrentMutations = Math.max(maxConcurrentMutations, activeMutations.length);
        activeMutations.splice(activeMutations.indexOf(`land:${floor.name}`), 1);
      }),
    });

    const controller = new FloorController({ bridge, initialFloors: [floorToDel] });

    // Dispara 3 operações de mutação simultâneas no mesmo workspace root com variações de / e \
    const pCreate1 = controller.createFloor({ rootPath: "C:/Repo/", name: "FirstFloor", branchName: "feat/1" });
    const pCreate2 = controller.createFloor({ rootPath: "C:\\Repo", name: "SecondFloor", branchName: "feat/2" });
    const pRemove = controller.removeFloor({ rootPath: "C:\\Repo\\", floor: floorToDel });

    // Aguarda ciclo de microtask para garantir enfileiramento inicial
    await new Promise((r) => setTimeout(r, 10));

    // Verifica que apenas a primeira operação de mutação está em voo no backend
    expect(activeMutations).toEqual(["create:FirstFloor"]);
    expect(maxConcurrentMutations).toBe(1);

    // Resolve a primeira criação
    resolveFirstCreate(makeFakeFloor("id-FirstFloor", "FirstFloor", "feat/1"));
    await pCreate1;
    await new Promise((r) => setTimeout(r, 10));

    // Agora a segunda criação foi concluída e a remoção deve estar em voo
    expect(activeMutations).toEqual(["remove:FloorToDel"]);
    expect(maxConcurrentMutations).toBe(1);

    resolveRemove();
    await pRemove;
    await pCreate2;

    expect(activeMutations).toEqual([]);
    expect(maxConcurrentMutations).toBe(1);
  });

  it("ordem exata do autoRunSetup: adiciona/notifica Floor retornado primeiro e depois executa runHooks(setup)", async () => {
    const executionOrder: string[] = [];

    const createdFloor = makeFakeFloor("f-auto", "AutoSetupFloor", "feat/auto");
    createdFloor.hooks = { setup: ["npm install"], run: [], teardown: [], autoRunSetup: true };

    const bridge = makeFakeBridge({
      createFloor: vi.fn().mockImplementation(async () => {
        executionOrder.push("bridge.createFloor");
        return createdFloor;
      }),
      runHooks: vi.fn().mockImplementation(async () => {
        executionOrder.push("bridge.runHooks");
      }),
    });

    const onFloorsChange = vi.fn().mockImplementation(() => {
      executionOrder.push("onFloorsChange");
    });

    const controller = new FloorController({ bridge, onFloorsChange });

    await controller.createFloor({
      rootPath: "C:\\Repo",
      name: "AutoSetupFloor",
      branchName: "feat/auto",
      hooks: { setup: ["npm install"], run: [], teardown: [], autoRunSetup: true },
    });

    expect(executionOrder).toEqual(["bridge.createFloor", "onFloorsChange", "bridge.runHooks"]);
    expect(bridge.runHooks).toHaveBeenCalledWith("C:\\Repo", createdFloor, "setup");
    expect(controller.getFloors()).toEqual([createdFloor]);
  });

  it("se autoRunSetup falhar, preserva o Floor criado na lista e exponha erro acionável sem rollback silencioso", async () => {
    const createdFloor = makeFakeFloor("f-fail", "FailSetupFloor", "feat/fail");
    createdFloor.hooks = { setup: ["failing_command"], run: [], teardown: [], autoRunSetup: true };

    const bridge = makeFakeBridge({
      createFloor: vi.fn().mockResolvedValue(createdFloor),
      runHooks: vi.fn().mockRejectedValue(new Error("Command failed: failing_command")),
    });

    const controller = new FloorController({ bridge });

    await expect(
      controller.createFloor({
        rootPath: "C:\\Repo",
        name: "FailSetupFloor",
        branchName: "feat/fail",
        hooks: { setup: ["failing_command"], run: [], teardown: [], autoRunSetup: true },
      })
    ).rejects.toThrow("Floor 'FailSetupFloor' criado, mas falha ao executar autoRunSetup: Command failed: failing_command");

    // O Floor DEVE ser preservado na lista e NAO removido silenciosamente
    expect(controller.getFloors()).toEqual([createdFloor]);
    expect(controller.getLastError()).toBe(
      "Floor 'FailSetupFloor' criado, mas falha ao executar autoRunSetup: Command failed: failing_command"
    );
  });

  it("preserva mutacoes de estado externas (setFloors) ocorridas durante a espera de um create/remove", async () => {
    let resolveRemove!: (val: void | PromiseLike<void>) => void;
    const removePromise = new Promise<void>((res) => {
      resolveRemove = res;
    });

    const bridge = makeFakeBridge({
      removeFloor: vi.fn().mockImplementation(() => removePromise),
    });

    const floor1 = makeFakeFloor("f-1", "Floor-1", "feat/1");
    const controller = new FloorController({ bridge, initialFloors: [floor1] });

    const pRemove = controller.removeFloor({
      rootPath: "C:\\Repo",
      floor: floor1,
      deleteBranch: true,
    });

    const floor2 = makeFakeFloor("f-2", "Floor-2", "feat/2");
    controller.setFloors([floor1, floor2]);

    resolveRemove();
    await pRemove;

    expect(controller.getFloors()).toEqual([floor2]);
    expect(bridge.removeFloor).toHaveBeenCalledWith("C:\\Repo", floor1, true);
  });

  it("trata rejeicao no backend sem corromper estado e registra erro acionavel", async () => {
    const bridge = makeFakeBridge({
      createFloor: vi.fn().mockRejectedValue(new Error("Git worktree error: branch lock conflict")),
    });

    const controller = new FloorController({ bridge });

    await expect(
      controller.createFloor({
        rootPath: "C:\\Repo",
        name: "Feature-Err",
        branchName: "feat/err",
      })
    ).rejects.toThrow("Git worktree error: branch lock conflict");

    expect(controller.getFloors()).toEqual([]);
    expect(controller.getLastError()).toBe("Git worktree error: branch lock conflict");
    expect(controller.isBusy()).toBe(false);
  });

  it("executa runHooks com hookType especifico ('setup'|'run'|'teardown')", async () => {
    const bridge = makeFakeBridge();
    const floor = makeFakeFloor("f-10", "Floor-Hooks", "feat/hooks");
    const controller = new FloorController({ bridge, initialFloors: [floor] });

    await controller.runHooks({
      rootPath: "C:\\Repo",
      floor,
      hookType: "setup",
    });

    expect(bridge.runHooks).toHaveBeenCalledWith("C:\\Repo", floor, "setup");
  });

  it("previewLand retorna LandPreview estruturado", async () => {
    const fakeLandPreview: LandPreview = {
      floorName: "Floor-1",
      floorBranch: "feat/1",
      targetBranch: "main",
      diffStat: "3 files changed, 20 insertions(+)",
    };
    const bridge = makeFakeBridge({
      previewLand: vi.fn().mockResolvedValue(fakeLandPreview),
    });

    const floor = makeFakeFloor("f-1", "Floor-1", "feat/1");
    const controller = new FloorController({ bridge, initialFloors: [floor] });

    const res = await controller.previewLand({
      rootPath: "C:\\Repo",
      floor,
      targetBranch: "main",
    });

    expect(res).toEqual(fakeLandPreview);
    expect(bridge.previewLand).toHaveBeenCalledWith("C:\\Repo", floor, "main");
  });

  it("normaliza case-insensitivity no Windows (C:\\Repo, c:\\repo\\, C:/Repo/) garantindo no máximo 1 mutação simultânea por workspace lock", async () => {
    let activeTasks = 0;
    let maxActiveTasks = 0;

    const bridge = makeFakeBridge({
      createFloor: vi.fn().mockImplementation(async (_root, name, branchName) => {
        activeTasks++;
        maxActiveTasks = Math.max(maxActiveTasks, activeTasks);
        await new Promise((r) => setTimeout(r, 40));
        activeTasks--;
        return makeFakeFloor(name, name, branchName);
      }),
    });

    const controller = new FloorController({ bridge });

    // Dispara requisições simultâneas com variação de case e slashes para o mesmo workspace
    const p1 = controller.createFloor({ rootPath: "C:\\Repo", name: "Floor-A", branchName: "feat/a" });
    const p2 = controller.createFloor({ rootPath: "c:\\repo\\", name: "Floor-B", branchName: "feat/b" });
    const p3 = controller.createFloor({ rootPath: "C:/Repo/", name: "Floor-C", branchName: "feat/c" });

    await Promise.all([p1, p2, p3]);

    expect(maxActiveTasks).toBe(1);
  });
});
