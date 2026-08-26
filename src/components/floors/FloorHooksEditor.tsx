import React, { useState, useEffect, useRef, useCallback } from "react";
import type { FloorHooks } from "./types";
import "./FloorOverviewPanel.css";

export interface FloorHooksEditorProps {
  isOpen: boolean;
  floorName: string;
  initialHooks: FloorHooks;
  isSubmitting?: boolean;
  isRunning?: boolean;
  onSave: (hooks: FloorHooks) => Promise<void> | void;
  onRunHook?: (phase: "setup" | "run" | "teardown" | "all") => Promise<void> | void;
  onCancel: () => void;
}

export const FloorHooksEditor: React.FC<FloorHooksEditorProps> = ({
  isOpen,
  floorName,
  initialHooks,
  isSubmitting = false,
  isRunning = false,
  onSave,
  onRunHook,
  onCancel,
}) => {
  const [hooks, setHooks] = useState<FloorHooks>({
    setup: [],
    run: [],
    teardown: [],
    autoRunSetup: false,
  });
  const [localBusy, setLocalBusy] = useState(false);
  const submittingRef = useRef(false);

  useEffect(() => {
    if (isOpen) {
      setHooks({
        setup: [...(initialHooks?.setup ?? [])],
        run: [...(initialHooks?.run ?? [])],
        teardown: [...(initialHooks?.teardown ?? [])],
        autoRunSetup: initialHooks?.autoRunSetup ?? false,
      });
      setLocalBusy(false);
      submittingRef.current = false;
    }
  }, [isOpen, initialHooks]);

  const isBusy = isSubmitting || isRunning || localBusy;

  const handleAddCommand = (phase: "setup" | "run" | "teardown") => {
    setHooks((prev) => ({
      ...prev,
      [phase]: [...prev[phase], ""],
    }));
  };

  const handleCommandChange = (phase: "setup" | "run" | "teardown", index: number, value: string) => {
    setHooks((prev) => {
      const updated = [...prev[phase]];
      updated[index] = value;
      return {
        ...prev,
        [phase]: updated,
      };
    });
  };

  const handleRemoveCommand = (phase: "setup" | "run" | "teardown", index: number) => {
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
    if (submittingRef.current || isBusy) return;
    submittingRef.current = true;
    setLocalBusy(true);
    try {
      await onSave(hooks);
    } finally {
      submittingRef.current = false;
      setLocalBusy(false);
    }
  }, [hooks, isBusy, onSave]);

  const handleRunAll = useCallback(async () => {
    if (!onRunHook || isBusy) return;
    setLocalBusy(true);
    try {
      await onRunHook("all");
    } finally {
      setLocalBusy(false);
    }
  }, [isBusy, onRunHook]);

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
        style={{ width: 540 }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="hooks-editor-title"
      >
        <div className="floor-panel__header">
          <h2 id="hooks-editor-title" className="floor-panel__title">
            Hooks Config — {floorName}
          </h2>
          <button
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
          {/* Setup Section */}
          <div className="floor-form-group">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <label>Setup Hooks (pós-criação)</label>
              <button
                type="button"
                className="floor-btn"
                onClick={() => handleAddCommand("setup")}
                disabled={isBusy}
              >
                + Add Command
              </button>
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
              <button
                type="button"
                className="floor-btn"
                onClick={() => handleAddCommand("run")}
                disabled={isBusy}
              >
                + Add Command
              </button>
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
              <button
                type="button"
                className="floor-btn"
                onClick={() => handleAddCommand("teardown")}
                disabled={isBusy}
              >
                + Add Command
              </button>
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
          {onRunHook && (
            <button
              type="button"
              className="floor-btn"
              onClick={handleRunAll}
              disabled={isBusy}
            >
              {isRunning ? "Executando..." : "⚡ Run All Hooks"}
            </button>
          )}

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
            {isSubmitting ? "Salvando..." : "Salvar Hooks"}
          </button>
        </div>
      </div>
    </div>
  );
};
