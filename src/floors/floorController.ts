import type { FloorEntry } from "../model/workspace";
import type { FloorBridge, FloorHooks, HookType, LandPreview } from "../lib/floorBridge";
import { defaultFloorBridge } from "../lib/floorBridge";

export interface CreateFloorParams {
  rootPath: string;
  name: string;
  branchName: string;
  useExistingBranch?: boolean;
  hooks?: FloorHooks;
}

export interface RemoveFloorParams {
  rootPath: string;
  floor: FloorEntry;
  deleteBranch?: boolean;
}

export interface RunHooksParams {
  rootPath: string;
  floor: FloorEntry;
  hookType: HookType;
}

export interface PreviewLandParams {
  rootPath: string;
  floor: FloorEntry;
  targetBranch: string;
}

export interface LandParams {
  rootPath: string;
  floor: FloorEntry;
  targetBranch: string;
}

export interface FloorControllerOptions {
  bridge?: FloorBridge;
  initialFloors?: FloorEntry[];
  onFloorsChange?: (floors: FloorEntry[]) => void;
}

export class FloorController {
  private bridge: FloorBridge;
  private floors: FloorEntry[];
  private onFloorsChange?: (floors: FloorEntry[]) => void;
  private pendingOperations: Set<string> = new Set();
  private workspaceLocks: Map<string, Promise<unknown>> = new Map();
  private lastError: string | null = null;

  constructor(options?: FloorControllerOptions) {
    this.bridge = options?.bridge ?? defaultFloorBridge;
    this.floors = options?.initialFloors ? [...options.initialFloors] : [];
    this.onFloorsChange = options?.onFloorsChange;
  }

  private normalizeRootPath(path: string): string {
    const raw = path.trim();
    const isUnc = /^([/\\]{2})/.test(raw);
    const isDrive = /^[a-zA-Z]:/.test(raw);

    let normalized = raw.replace(/[/\\]+/g, "/");
    if (isUnc) {
      normalized = "/" + normalized;
    }

    if (normalized.length > 1 && normalized.endsWith("/")) {
      normalized = normalized.slice(0, -1);
    }

    const isWindowsPath = isDrive || isUnc;
    return isWindowsPath ? normalized.toLowerCase() : normalized;
  }

  private async withWorkspaceLock<T>(rootPath: string, task: () => Promise<T>): Promise<T> {
    const normalizedRoot = this.normalizeRootPath(rootPath);
    const currentLock = this.workspaceLocks.get(normalizedRoot) ?? Promise.resolve();

    let releaseLock: () => void = () => {};
    const nextLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    this.workspaceLocks.set(normalizedRoot, currentLock.then(() => nextLock, () => nextLock));

    try {
      await currentLock;
      return await task();
    } finally {
      releaseLock();
      if (this.workspaceLocks.get(normalizedRoot) === nextLock) {
        this.workspaceLocks.delete(normalizedRoot);
      }
    }
  }

  public getFloors(): FloorEntry[] {
    return [...this.floors];
  }

  public setFloors(floors: FloorEntry[], options?: { silent?: boolean }): void {
    this.floors = [...floors];
    if (!options?.silent) {
      this.onFloorsChange?.(this.getFloors());
    }
  }

  public getLastError(): string | null {
    return this.lastError;
  }

  public isBusy(operationKey?: string): boolean {
    if (operationKey) {
      return this.pendingOperations.has(operationKey);
    }
    return this.pendingOperations.size > 0;
  }

  public async getCurrentBranch(rootPath: string): Promise<string> {
    const trimmedPath = rootPath.trim();
    if (!trimmedPath) {
      const msg = "Diretorio raiz (rootPath) nao pode ser vazio.";
      this.lastError = msg;
      throw new Error(msg);
    }

    const opKey = `currentBranch:${trimmedPath}`;
    if (this.pendingOperations.has(opKey)) {
      throw new Error(`Operacao em andamento: ${opKey}`);
    }
    this.pendingOperations.add(opKey);
    this.lastError = null;

    try {
      return await this.bridge.currentBranch(trimmedPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = msg;
      throw new Error(msg);
    } finally {
      this.pendingOperations.delete(opKey);
    }
  }

  public async createFloor(params: CreateFloorParams): Promise<FloorEntry> {
    const { rootPath, name, branchName, useExistingBranch, hooks } = params;
    const trimmedPath = rootPath.trim();
    const trimmedName = name.trim();
    const trimmedBranch = branchName.trim();

    if (!trimmedPath) {
      const msg = "Diretorio raiz (rootPath) nao pode ser vazio.";
      this.lastError = msg;
      throw new Error(msg);
    }
    if (!trimmedName) {
      const msg = "Nome do Floor nao pode ser vazio.";
      this.lastError = msg;
      throw new Error(msg);
    }
    if (!trimmedBranch) {
      const msg = "Nome da branch do Floor nao pode ser vazio.";
      this.lastError = msg;
      throw new Error(msg);
    }

    const opKey = `createFloor:${trimmedName}`;
    if (this.pendingOperations.has(opKey)) {
      throw new Error(`Criacao de Floor '${trimmedName}' ja esta em andamento.`);
    }

    if (this.floors.some((f) => f.name.toLowerCase() === trimmedName.toLowerCase())) {
      const msg = `Ja existe um Floor com o nome '${trimmedName}'.`;
      this.lastError = msg;
      throw new Error(msg);
    }

    this.pendingOperations.add(opKey);
    this.lastError = null;

    try {
      return await this.withWorkspaceLock(trimmedPath, async () => {
        const createdFloor = await this.bridge.createFloor(
          trimmedPath,
          trimmedName,
          trimmedBranch,
          useExistingBranch,
          hooks
        );
        // Aplica o resultado sobre o estado corrente para evitar perda de updates (concorrencia externa)
        this.floors = [...this.floors.filter((f) => f.id !== createdFloor.id), createdFloor];
        this.onFloorsChange?.(this.getFloors());

        // Fonte autoritativa do autoRunSetup é createdFloor.hooks retornado pelo backend
        const authoritativeHooks = (createdFloor.hooks || {}) as unknown as FloorHooks;
        if (authoritativeHooks.autoRunSetup && authoritativeHooks.setup && authoritativeHooks.setup.length > 0) {
          try {
            await this.bridge.runHooks(trimmedPath, createdFloor, "setup");
          } catch (hookErr) {
            const msg = `Floor '${createdFloor.name}' criado, mas falha ao executar autoRunSetup: ${
              hookErr instanceof Error ? hookErr.message : String(hookErr)
            }`;
            this.lastError = msg;
            throw new Error(msg);
          }
        }

        return createdFloor;
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = msg;
      throw new Error(msg);
    } finally {
      this.pendingOperations.delete(opKey);
    }
  }

  public async removeFloor(params: RemoveFloorParams): Promise<void> {
    const { rootPath, floor, deleteBranch } = params;
    const trimmedPath = rootPath.trim();

    if (!trimmedPath) {
      const msg = "Diretorio raiz (rootPath) nao pode ser vazio.";
      this.lastError = msg;
      throw new Error(msg);
    }

    const opKey = `removeFloor:${floor.id}`;
    if (this.pendingOperations.has(opKey)) {
      throw new Error(`Remocao do Floor '${floor.name}' ja esta em andamento.`);
    }

    this.pendingOperations.add(opKey);
    this.lastError = null;

    try {
      await this.withWorkspaceLock(trimmedPath, async () => {
        await this.bridge.removeFloor(trimmedPath, floor, deleteBranch);
        // Aplica remocao sobre o estado corrente mantendo mutacoes externas ocorridas durante a espera
        this.floors = this.floors.filter((f) => f.id !== floor.id);
        this.onFloorsChange?.(this.getFloors());
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = msg;
      throw new Error(msg);
    } finally {
      this.pendingOperations.delete(opKey);
    }
  }

  public async runHooks(params: RunHooksParams): Promise<void> {
    const { rootPath, floor, hookType } = params;
    const trimmedPath = rootPath.trim();

    if (!trimmedPath) {
      const msg = "Diretorio raiz (rootPath) nao pode ser vazio.";
      this.lastError = msg;
      throw new Error(msg);
    }

    const opKey = `runHooks:${floor.id}:${hookType}`;
    if (this.pendingOperations.has(opKey)) {
      throw new Error(`Execucao de hook '${hookType}' para o Floor '${floor.name}' ja esta em andamento.`);
    }

    this.pendingOperations.add(opKey);
    this.lastError = null;

    try {
      await this.withWorkspaceLock(trimmedPath, async () => {
        await this.bridge.runHooks(trimmedPath, floor, hookType);
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = msg;
      throw new Error(msg);
    } finally {
      this.pendingOperations.delete(opKey);
    }
  }

  public async previewLand(params: PreviewLandParams): Promise<LandPreview> {
    const { rootPath, floor, targetBranch } = params;
    const trimmedPath = rootPath.trim();
    const trimmedTarget = targetBranch.trim();

    if (!trimmedPath) {
      const msg = "Diretorio raiz (rootPath) nao pode ser vazio.";
      this.lastError = msg;
      throw new Error(msg);
    }
    if (!trimmedTarget) {
      const msg = "Branch de destino (targetBranch) nao pode ser vazia.";
      this.lastError = msg;
      throw new Error(msg);
    }

    const opKey = `previewLand:${floor.id}`;
    if (this.pendingOperations.has(opKey)) {
      throw new Error(`Preview de landing para o Floor '${floor.name}' ja esta em andamento.`);
    }

    this.pendingOperations.add(opKey);
    this.lastError = null;

    try {
      return await this.bridge.previewLand(trimmedPath, floor, trimmedTarget);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = msg;
      throw new Error(msg);
    } finally {
      this.pendingOperations.delete(opKey);
    }
  }

  public async land(params: LandParams): Promise<void> {
    const { rootPath, floor, targetBranch } = params;
    const trimmedPath = rootPath.trim();
    const trimmedTarget = targetBranch.trim();

    if (!trimmedPath) {
      const msg = "Diretorio raiz (rootPath) nao pode ser vazio.";
      this.lastError = msg;
      throw new Error(msg);
    }
    if (!trimmedTarget) {
      const msg = "Branch de destino (targetBranch) nao pode ser vazia.";
      this.lastError = msg;
      throw new Error(msg);
    }

    const opKey = `land:${floor.id}`;
    if (this.pendingOperations.has(opKey)) {
      throw new Error(`Landing para o Floor '${floor.name}' ja esta em andamento.`);
    }

    this.pendingOperations.add(opKey);
    this.lastError = null;

    try {
      await this.withWorkspaceLock(trimmedPath, async () => {
        await this.bridge.land(trimmedPath, floor, trimmedTarget);
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = msg;
      throw new Error(msg);
    } finally {
      this.pendingOperations.delete(opKey);
    }
  }
}
