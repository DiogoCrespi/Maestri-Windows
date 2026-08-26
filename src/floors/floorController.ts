import type { FloorEntry } from "../model/workspace";
import type { FloorBridge } from "../lib/floorBridge";
import { defaultFloorBridge } from "../lib/floorBridge";

export interface CreateFloorParams {
  name: string;
  branchName: string;
  workingDirectory: string;
}

export interface RemoveFloorParams {
  floor: FloorEntry;
  workingDirectory: string;
}

export interface RunHooksParams {
  hooks: string[];
  floor: FloorEntry;
  workingDirectory: string;
}

export interface PreviewLandParams {
  floor: FloorEntry;
  targetBranch: string;
  workingDirectory: string;
}

export interface LandParams {
  floor: FloorEntry;
  targetBranch: string;
  workingDirectory: string;
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
  private lastError: string | null = null;

  constructor(options?: FloorControllerOptions) {
    this.bridge = options?.bridge ?? defaultFloorBridge;
    this.floors = options?.initialFloors ? [...options.initialFloors] : [];
    this.onFloorsChange = options?.onFloorsChange;
  }

  public getFloors(): FloorEntry[] {
    return [...this.floors];
  }

  public setFloors(floors: FloorEntry[]): void {
    this.floors = [...floors];
    this.onFloorsChange?.(this.getFloors());
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

  public async getCurrentBranch(workingDirectory: string): Promise<string> {
    const opKey = `currentBranch:${workingDirectory}`;
    if (this.pendingOperations.has(opKey)) {
      throw new Error(`Operacao em andamento: ${opKey}`);
    }
    this.pendingOperations.add(opKey);
    this.lastError = null;

    try {
      return await this.bridge.currentBranch(workingDirectory);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = msg;
      throw new Error(msg);
    } finally {
      this.pendingOperations.delete(opKey);
    }
  }

  public async createFloor(params: CreateFloorParams): Promise<FloorEntry> {
    const { name, branchName, workingDirectory } = params;
    const trimmedName = name.trim();
    const trimmedBranch = branchName.trim();
    const trimmedDir = workingDirectory.trim();

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
    if (!trimmedDir) {
      const msg = "Diretorio de trabalho nao pode ser vazio.";
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
      const createdFloor = await this.bridge.createFloor(trimmedName, trimmedBranch, trimmedDir);
      this.floors = [...this.floors, createdFloor];
      this.onFloorsChange?.(this.getFloors());
      return createdFloor;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = msg;
      throw new Error(msg);
    } finally {
      this.pendingOperations.delete(opKey);
    }
  }

  public async removeFloor(params: RemoveFloorParams): Promise<void> {
    const { floor, workingDirectory } = params;
    const opKey = `removeFloor:${floor.id}`;

    if (this.pendingOperations.has(opKey)) {
      throw new Error(`Remocao do Floor '${floor.name}' ja esta em andamento.`);
    }

    this.pendingOperations.add(opKey);
    this.lastError = null;

    try {
      await this.bridge.removeFloor(floor, workingDirectory);
      this.floors = this.floors.filter((f) => f.id !== floor.id);
      this.onFloorsChange?.(this.getFloors());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = msg;
      throw new Error(msg);
    } finally {
      this.pendingOperations.delete(opKey);
    }
  }

  public async runHooks(params: RunHooksParams): Promise<void> {
    const { hooks, floor, workingDirectory } = params;
    const opKey = `runHooks:${floor.id}`;

    if (this.pendingOperations.has(opKey)) {
      throw new Error(`Execucao de hooks para o Floor '${floor.name}' ja esta em andamento.`);
    }

    this.pendingOperations.add(opKey);
    this.lastError = null;

    try {
      await this.bridge.runHooks(hooks, floor, workingDirectory);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = msg;
      throw new Error(msg);
    } finally {
      this.pendingOperations.delete(opKey);
    }
  }

  public async previewLand(params: PreviewLandParams): Promise<string> {
    const { floor, targetBranch, workingDirectory } = params;
    const opKey = `previewLand:${floor.id}`;

    if (this.pendingOperations.has(opKey)) {
      throw new Error(`Preview de landing para o Floor '${floor.name}' ja esta em andamento.`);
    }

    this.pendingOperations.add(opKey);
    this.lastError = null;

    try {
      return await this.bridge.previewLand(floor, targetBranch, workingDirectory);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = msg;
      throw new Error(msg);
    } finally {
      this.pendingOperations.delete(opKey);
    }
  }

  public async land(params: LandParams): Promise<void> {
    const { floor, targetBranch, workingDirectory } = params;
    const opKey = `land:${floor.id}`;

    if (this.pendingOperations.has(opKey)) {
      throw new Error(`Landing para o Floor '${floor.name}' ja esta em andamento.`);
    }

    this.pendingOperations.add(opKey);
    this.lastError = null;

    try {
      await this.bridge.land(floor, targetBranch, workingDirectory);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = msg;
      throw new Error(msg);
    } finally {
      this.pendingOperations.delete(opKey);
    }
  }
}
