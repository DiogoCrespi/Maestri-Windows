import type { CreateFloorInput, FloorHooks, FloorItem } from "./types";

export function slugifyBranchName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9_/-]/g, "");
}

export function validateCreateFloorInput(input: CreateFloorInput): { isValid: boolean; error?: string } {
  const name = input.name.trim();
  const branch = input.branchName.trim();
  if (!name) return { isValid: false, error: "Nome do Floor não pode ser vazio" };
  if (!branch) return { isValid: false, error: "Nome da branch não pode ser vazio" };
  if (!/^[a-zA-Z0-9_/-]+$/.test(branch)) {
    return { isValid: false, error: "Nome da branch contém caracteres inválidos" };
  }
  return { isValid: true };
}

export function validateFloorHooks(hooks: FloorHooks): { isValid: boolean; cleaned: FloorHooks } {
  const cleanList = (arr: string[]) =>
    Array.isArray(arr) ? arr.map((s) => s.trim()).filter((s) => s.length > 0) : [];
  return {
    isValid: true,
    cleaned: {
      setup: cleanList(hooks.setup),
      run: cleanList(hooks.run),
      teardown: cleanList(hooks.teardown),
      autoRunSetup: Boolean(hooks.autoRunSetup),
    },
  };
}

export function selectFloorId(_currentActive: string | null, clickedId: string | null): string | null {
  return clickedId === "ground" ? null : clickedId;
}

export function filterFloorsList(floors: FloorItem[], search: string): FloorItem[] {
  const query = search.trim().toLowerCase();
  if (!query) return floors;
  return floors.filter(
    (f) => f.name.toLowerCase().includes(query) || f.branchName.toLowerCase().includes(query),
  );
}

export interface DoubleSubmitGuard {
  readonly isBusy: boolean;
  tryExecute: <T>(action: () => Promise<T> | T) => Promise<T | undefined>;
}

export function createDoubleSubmitGuard(): DoubleSubmitGuard {
  let isBusy = false;
  return {
    get isBusy() {
      return isBusy;
    },
    async tryExecute<T>(action: () => Promise<T> | T): Promise<T | undefined> {
      if (isBusy) return undefined;
      isBusy = true;
      try {
        return await action();
      } finally {
        isBusy = false;
      }
    },
  };
}
