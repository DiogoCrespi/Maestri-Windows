import React, { useState, useEffect, useRef, useCallback } from "react";
import type { FloorHooks, HookPhase } from "./types";
import { sanitizeFloorHooks, FloorOperationController, useDialogFocus } from "./controller";
import "./FloorOverviewPanel.css";

export interface FloorHooksEditorProps {
  isOpen: boolean;
  floorName: string;
  initialHooks: FloorHooks;
  isSubmitting?: boolean;
  isRunning?: boolean;
  error?: string | null;
  onSave: (hooks: FloorHooks) => Promise<void> | void;
  onRunHook?: (phase: HookPhase) => Promise<void> | void;
  onCancel: () => void;
  controller?: FloorOperationController;
}

export const FloorHooksEditor: React.FC<FloorHooksEditorProps> = ({
  isOpen,
  floorName,
  initialHooks,
  isSubmitting = false,
  isRunning = false,
  error = null,
  onSave,
  onRunHook,
  onCancel,
  controller,
}) => {
  const [hooks, setHooks] = useState<FloorHooks>({
    setup: [],
    run: [],
    teardown: [],
    autoRunSetup: false,
  });
  const [localSubmitting, setLocalSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const internalControllerRef = useRef<FloorOperationController>(controller || new FloorOperationController());

  useDialogFocus(isOpen, closeBtnRef);

  useEffect(() => {
    if (isOpen) {
      setHooks(sanitizeFloorHooks(initialHooks, {}));
      setLocalSubmitting(false);
      setLocalError(null);
      internalControllerRef.current.clearError();
    }
  }, [isOpen, initialHooks]);

  const isBusy = isSubmitting || isRunning || localSubmitting || internalControllerRef.current.isSubmitting;
  const activeError = error || localError || internalControllerRef.current.error;

  const handleAddCommand = (phase: HookPhase) => {
    setHooks((prev) => ({
      ...prev,
      [phase]: [...prev[phase], ""],
    }));
  };

  const handleCommandChange = (phase: HookPhase, index: number, value: string) => {
    setHooks((prev) => {
      const updated = [...prev[phase]];
      updated[index] = value;
      return {
        ...prev,
        [phase]: updated,
      };
    });
  };

  const handleRemoveCommand = (phase: HookPhase, index: number) => {
    setHooks((prev) => {
      const updated = [...prev[phase]];
      updated.splice(index, 1);
      return {
        ...prev,
        [phase]: updated,
      };
    });
  };

  const handleSave = useCallback(async () => {
    const cleanedHooks = sanitizeFloorHooks(initialHooks, hooks);
    setLocalError(null);
    const ctrl = controller || internalControllerRef.current;
    const res = await ctrl.runOperation(
      () => onSave(cleanedHooks),
      (state) => setLocalSubmitting(state.isSubmitting),
    );

    if (!res.success && res.error) {
      setLocalError(res.error);
    }
  }, [controller, hooks, initialHooks, onSave]);

  const handleRunPhase = useCallback(
    async (phase: HookPhase) => {
      if (!onRunHook) return;
      setLocalError(null);
      const ctrl = controller || internalControllerRef.current;
      const res = await ctrl.runOperation(
        () => onRunHook(phase),
        (state) => setLocalSubmitting(state.isSubmitting),
      );

      if (!res.success && res.error) {
        setLocalError(res.error);
      }
    },
    [controller, onRunHook],
  );

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isBusy) {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, isBusy, onCancel]);

  if (!isOpen) return null;

  return (
    <div className="floor-panel-overlay" data-testid="hooks-editor-overlay">
      <div
        className="floor-dialog"
        style={{ width: 560 }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="hooks-editor-title"
      >
        <div className="floor-panel__header">
          <h2 id="hooks-editor-title" className="floor-panel__title">
            Hooks Config — {floorName}
          </h2>
          <button
            ref={closeBtnRef}
            type="button"
            className="floor-panel__close-btn"
            onClick={onCancel}
            disabled={isBusy}
            aria-label="Fechar editor de hooks"
          >
            ×
          </button>
        </div>

        <div className="floor-panel__body">
          {activeError && (
            <div className="floor-panel__error" role="alert">
              ⚠️ {activeError}
            </div>
          )}

          {/* Setup Section */}
          <div className="floor-form-group">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <label>Setup Hooks (pós-criação)</label>
              <div style={{ display: "flex", gap: 6 }}>
                {onRunHook && (
                  <button
                    type="button"
                    className="floor-btn"
                    onClick={() => handleRunPhase("setup")}
                    disabled={isBusy}
                    title="Executar Setup Hooks"
                  >
                    ⚡ Run Setup
                  </button>
                )}
                <button
                  type="button"
                  className="floor-btn"
                  onClick={() => handleAddCommand("setup")}
                  disabled={isBusy}
                >
                  + Add Command
                </button>
              </div>
            </div>
            {hooks.setup.map((cmd, idx) => (
              <div key={`setup-${idx}`} style={{ display: "flex", gap: 6, marginTop: 4 }}>
                <input
                  type="text"
                  className="floor-input"
                  style={{ flex: 1 }}
                  placeholder="ex: npm install"
                  value={cmd}
                  onChange={(e) => handleCommandChange("setup", idx, e.target.value)}
                  disabled={isBusy}
                />
                <button
                  type="button"
                  className="floor-btn floor-btn--danger"
                  onClick={() => handleRemoveCommand("setup", idx)}
                  disabled={isBusy}
                  aria-label={`Remover comando setup ${idx + 1}`}
                >
                  -
                </button>
              </div>
            ))}
            <div style={{ marginTop: 8 }}>
              <label className="floor-checkbox-group">
                <input
                  type="checkbox"
                  checked={hooks.autoRunSetup}
                  onChange={(e) => setHooks((prev) => ({ ...prev, autoRunSetup: e.target.checked }))}
                  disabled={isBusy}
                />
                Executar Setup Hooks automaticamente ao criar o Floor
              </label>
            </div>
          </div>

          <hr style={{ borderColor: "#27272a", margin: "12px 0" }} />

          {/* Run Section */}
          <div className="floor-form-group">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <label>Run Hooks (sob demanda)</label>
              <div style={{ display: "flex", gap: 6 }}>
                {onRunHook && (
                  <button
                    type="button"
                    className="floor-btn floor-btn--primary"
                    onClick={() => handleRunPhase("run")}
                    disabled={isBusy}
                    title="Executar Run Hooks principais"
                  >
                    ⚡ Run Hooks
                  </button>
                )}
                <button
                  type="button"
                  className="floor-btn"
                  onClick={() => handleAddCommand("run")}
                  disabled={isBusy}
                >
                  + Add Command
                </button>
              </div>
            </div>
            {hooks.run.map((cmd, idx) => (
              <div key={`run-${idx}`} style={{ display: "flex", gap: 6, marginTop: 4 }}>
                <input
                  type="text"
                  className="floor-input"
                  style={{ flex: 1 }}
                  placeholder="ex: npm test"
                  value={cmd}
                  onChange={(e) => handleCommandChange("run", idx, e.target.value)}
                  disabled={isBusy}
                />
                <button
                  type="button"
                  className="floor-btn floor-btn--danger"
                  onClick={() => handleRemoveCommand("run", idx)}
                  disabled={isBusy}
                  aria-label={`Remover comando run ${idx + 1}`}
                >
                  -
                </button>
              </div>
            ))}
          </div>

          <hr style={{ borderColor: "#27272a", margin: "12px 0" }} />

          {/* Teardown Section */}
          <div className="floor-form-group">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <label>Teardown Hooks (ao excluir)</label>
              <div style={{ display: "flex", gap: 6 }}>
                {onRunHook && (
                  <button
                    type="button"
                    className="floor-btn"
                    onClick={() => handleRunPhase("teardown")}
                    disabled={isBusy}
                    title="Executar Teardown Hooks"
                  >
                    ⚡ Run Teardown
                  </button>
                )}
                <button
                  type="button"
                  className="floor-btn"
                  onClick={() => handleAddCommand("teardown")}
                  disabled={isBusy}
                >
                  + Add Command
                </button>
              </div>
            </div>
            {hooks.teardown.map((cmd, idx) => (
              <div key={`teardown-${idx}`} style={{ display: "flex", gap: 6, marginTop: 4 }}>
                <input
                  type="text"
                  className="floor-input"
                  style={{ flex: 1 }}
                  placeholder="ex: docker compose down"
                  value={cmd}
                  onChange={(e) => handleCommandChange("teardown", idx, e.target.value)}
                  disabled={isBusy}
                />
                <button
                  type="button"
                  className="floor-btn floor-btn--danger"
                  onClick={() => handleRemoveCommand("teardown", idx)}
                  disabled={isBusy}
                  aria-label={`Remover comando teardown ${idx + 1}`}
                >
                  -
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="floor-panel__footer">
          <button
            type="button"
            className="floor-btn"
            onClick={onCancel}
            disabled={isBusy}
          >
            Cancelar
          </button>

          <button
            type="button"
            className="floor-btn floor-btn--primary"
            onClick={handleSave}
            disabled={isBusy}
          >
            {isBusy ? "Salvando..." : "Salvar Hooks"}
          </button>
        </div>
      </div>
    </div>
  );
};
