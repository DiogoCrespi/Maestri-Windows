import { useEffect, useRef } from "react";
import type { CreateFloorInput, FloorHooks } from "./types";

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

export function sanitizeFloorHooks(initialHooks: FloorHooks, updated: Partial<FloorHooks>): FloorHooks {
  const cleanList = (arr: unknown) =>
    Array.isArray(arr) ? arr.map((s) => (typeof s === "string" ? s.trim() : "")).filter((s) => s.length > 0) : [];
  return {
    ...initialHooks,
    ...updated,
    setup: updated.setup ? cleanList(updated.setup) : cleanList(initialHooks.setup),
    run: updated.run ? cleanList(updated.run) : cleanList(initialHooks.run),
    teardown: updated.teardown ? cleanList(updated.teardown) : cleanList(initialHooks.teardown),
    autoRunSetup: updated.autoRunSetup !== undefined ? Boolean(updated.autoRunSetup) : Boolean(initialHooks.autoRunSetup),
  };
}

export interface FloorControllerState {
  isSubmitting: boolean;
  error: string | null;
}

export class FloorOperationController {
  private busy = false;
  private currentError: string | null = null;

  get isSubmitting(): boolean {
    return this.busy;
  }

  get error(): string | null {
    return this.currentError;
  }

  clearError(): void {
    this.currentError = null;
  }

  async runOperation<T>(
    operation: () => Promise<T> | T,
    onStateChange?: (state: FloorControllerState) => void,
  ): Promise<{ success: boolean; result?: T; error?: string }> {
    if (this.busy) {
      return { success: false, error: "Operação já em andamento" };
    }
    this.busy = true;
    this.currentError = null;
    onStateChange?.({ isSubmitting: true, error: null });

    try {
      const result = await Promise.resolve().then(() => operation());
      this.busy = false;
      onStateChange?.({ isSubmitting: false, error: null });
      return { success: true, result };
    } catch (err: unknown) {
      this.busy = false;
      const errorMessage = err instanceof Error ? err.message : String(err || "Erro na operação");
      this.currentError = errorMessage;
      onStateChange?.({ isSubmitting: false, error: errorMessage });
      return { success: false, error: errorMessage };
    }
  }
}

export function useDialogFocus(isOpen: boolean, initialInputRef?: React.RefObject<HTMLElement | null>) {
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (isOpen) {
      previousFocusRef.current = document.activeElement as HTMLElement | null;
      const timer = setTimeout(() => {
        initialInputRef?.current?.focus();
      }, 30);
      return () => {
        clearTimeout(timer);
        if (previousFocusRef.current && typeof previousFocusRef.current.focus === "function") {
          previousFocusRef.current.focus();
        }
      };
    }
  }, [isOpen, initialInputRef]);
}
