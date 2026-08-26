import React, { useState, useEffect, useRef, useCallback } from "react";
import type { DeleteFloorInput, FloorItem } from "./types";
import "./FloorOverviewPanel.css";

export interface DeleteFloorDialogProps {
  isOpen: boolean;
  floor: FloorItem | null;
  isSubmitting?: boolean;
  onConfirm: (input: DeleteFloorInput) => Promise<void> | void;
  onCancel: () => void;
}

export const DeleteFloorDialog: React.FC<DeleteFloorDialogProps> = ({
  isOpen,
  floor,
  isSubmitting = false,
  onConfirm,
  onCancel,
}) => {
  const [keepBranch, setKeepBranch] = useState(true);
  const [localSubmitting, setLocalSubmitting] = useState(false);
  const submittingRef = useRef(false);

  useEffect(() => {
    if (isOpen) {
      setKeepBranch(true);
      setLocalSubmitting(false);
      submittingRef.current = false;
    }
  }, [isOpen]);

  const isBusy = isSubmitting || localSubmitting;

  const handleConfirm = useCallback(async () => {
    if (!floor || submittingRef.current || isBusy) return;
    submittingRef.current = true;
    setLocalSubmitting(true);
    try {
      await onConfirm({
        floorId: floor.id,
        keepBranch,
      });
    } finally {
      submittingRef.current = false;
      setLocalSubmitting(false);
    }
  }, [floor, isBusy, keepBranch, onConfirm]);

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
