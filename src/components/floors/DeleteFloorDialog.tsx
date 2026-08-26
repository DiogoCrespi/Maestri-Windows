import React, { useState, useEffect, useRef, useCallback } from "react";
import type { DeleteFloorInput, FloorItem } from "./types";
import { FloorOperationController, useDialogFocus } from "./controller";
import "./FloorOverviewPanel.css";

export interface DeleteFloorDialogProps {
  isOpen: boolean;
  floor: FloorItem | null;
  isSubmitting?: boolean;
  error?: string | null;
  onConfirm: (input: DeleteFloorInput) => Promise<void> | void;
  onCancel: () => void;
  controller?: FloorOperationController;
}

export const DeleteFloorDialog: React.FC<DeleteFloorDialogProps> = ({
  isOpen,
  floor,
  isSubmitting = false,
  error = null,
  onConfirm,
  onCancel,
  controller,
}) => {
  const [keepBranch, setKeepBranch] = useState(true);
  const [localSubmitting, setLocalSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const deleteBtnRef = useRef<HTMLButtonElement>(null);
  const internalControllerRef = useRef<FloorOperationController>(controller || new FloorOperationController());

  useDialogFocus(isOpen, deleteBtnRef);

  useEffect(() => {
    if (isOpen) {
      setKeepBranch(true);
      setLocalSubmitting(false);
      setLocalError(null);
      internalControllerRef.current.clearError();
    }
  }, [isOpen]);

  const isBusy = isSubmitting || localSubmitting || internalControllerRef.current.isSubmitting;
  const activeError = error || localError || internalControllerRef.current.error;

  const handleConfirm = useCallback(async () => {
    if (!floor) return;
    setLocalError(null);
    const ctrl = controller || internalControllerRef.current;
    const res = await ctrl.runOperation(
      () => onConfirm({ floorId: floor.id, keepBranch }),
      (state) => setLocalSubmitting(state.isSubmitting),
    );

    if (!res.success && res.error) {
      setLocalError(res.error);
    }
  }, [controller, floor, keepBranch, onConfirm]);

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

  if (!isOpen || !floor) return null;

  return (
    <div className="floor-panel-overlay" data-testid="delete-floor-overlay">
      <div
        className="floor-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-floor-title"
      >
        <div className="floor-panel__header">
          <h2 id="delete-floor-title" className="floor-panel__title" style={{ color: "#ef4444" }}>
            Remover Floor — {floor.name}
          </h2>
          <button
            type="button"
            className="floor-panel__close-btn"
            onClick={onCancel}
            disabled={isBusy}
            aria-label="Fechar diálogo de remoção"
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

          <p style={{ fontSize: 14, color: "#d4d4d8", margin: "0 0 12px 0" }}>
            Você está prestes a remover o Floor <strong>{floor.name}</strong> (branch: <code>{floor.branchName}</code>). O diretório clonado da worktree será excluído.
          </p>

          <div className="floor-form-group">
            <label className="floor-checkbox-group">
              <input
                type="radio"
                name="branchOption"
                checked={keepBranch}
                onChange={() => setKeepBranch(true)}
                disabled={isBusy}
              />
              <strong>Manter a branch Git</strong> (a branch <code>{floor.branchName}</code> continuará no repositório)
            </label>
          </div>

          <div className="floor-form-group">
            <label className="floor-checkbox-group">
              <input
                type="radio"
                name="branchOption"
                checked={!keepBranch}
                onChange={() => setKeepBranch(false)}
                disabled={isBusy}
              />
              <strong>Excluir também a branch Git</strong> (remove o Floor e a branch <code>{floor.branchName}</code>)
            </label>
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
            ref={deleteBtnRef}
            type="button"
            className="floor-btn floor-btn--danger"
            onClick={handleConfirm}
            disabled={isBusy}
          >
            {isBusy ? "Removendo..." : "Excluir Floor"}
          </button>
        </div>
      </div>
    </div>
  );
};
