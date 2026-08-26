import React, { useState, useEffect, useRef, useCallback } from "react";
import type { CreateFloorInput } from "./types";
import { slugifyBranchName } from "./helpers";
import "./FloorOverviewPanel.css";

export interface CreateFloorDialogProps {
  isOpen: boolean;
  isSubmitting?: boolean;
  error?: string | null;
  onSubmit: (input: CreateFloorInput) => Promise<void> | void;
  onCancel: () => void;
}



export const CreateFloorDialog: React.FC<CreateFloorDialogProps> = ({
  isOpen,
  isSubmitting = false,
  error = null,
  onSubmit,
  onCancel,
}) => {
  const [name, setName] = useState("");
  const [branchName, setBranchName] = useState("");
  const [useExistingBranch, setUseExistingBranch] = useState(false);
  const [localSubmitting, setLocalSubmitting] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const submittingRef = useRef(false);

  useEffect(() => {
    if (isOpen) {
      setName("");
      setBranchName("");
      setUseExistingBranch(false);
      setLocalSubmitting(false);
      submittingRef.current = false;
      setTimeout(() => nameInputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setName(val);
    if (!useExistingBranch) {
      setBranchName(slugifyBranchName(val));
    }
  };

  const handleBranchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setBranchName(e.target.value);
  };

  const handleToggleUseExisting = (e: React.ChangeEvent<HTMLInputElement>) => {
    const checked = e.target.checked;
    setUseExistingBranch(checked);
    if (!checked && name.trim()) {
      setBranchName(slugifyBranchName(name));
    }
  };

  const isBusy = isSubmitting || localSubmitting;

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (submittingRef.current || isBusy) return;
      const trimmedName = name.trim();
      const trimmedBranch = branchName.trim();
      if (!trimmedName || !trimmedBranch) return;

      submittingRef.current = true;
      setLocalSubmitting(true);
      try {
        await onSubmit({
          name: trimmedName,
          branchName: trimmedBranch,
          useExistingBranch,
        });
      } finally {
        submittingRef.current = false;
        setLocalSubmitting(false);
      }
    },
    [branchName, isBusy, name, onSubmit, useExistingBranch],
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

  const isFormValid = name.trim().length > 0 && branchName.trim().length > 0;

  return (
    <div className="floor-panel-overlay" data-testid="create-floor-overlay">
      <div
        className="floor-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-floor-dialog-title"
      >
        <div className="floor-panel__header">
          <h2 id="create-floor-dialog-title" className="floor-panel__title">
            Novo Floor
          </h2>
          <button
            type="button"
            className="floor-panel__close-btn"
            onClick={onCancel}
            disabled={isBusy}
            aria-label="Fechar formulário"
          >
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="floor-panel__body">
            {error && <div className="floor-panel__error" role="alert">{error}</div>}

            <div className="floor-form-group">
              <label htmlFor="create-floor-name">Nome do Floor</label>
              <input
                id="create-floor-name"
                ref={nameInputRef}
                type="text"
                className="floor-input"
                placeholder="ex: Fix login bug"
                value={name}
                onChange={handleNameChange}
                disabled={isBusy}
                required
              />
            </div>

            <div className="floor-form-group">
              <label htmlFor="create-floor-branch">Nome da Branch Git</label>
              <input
                id="create-floor-branch"
                type="text"
                className="floor-input"
                placeholder="ex: fix-login-bug"
                value={branchName}
                onChange={handleBranchChange}
                disabled={isBusy}
                required
              />
            </div>

            <div className="floor-form-group">
              <label className="floor-checkbox-group">
                <input
                  type="checkbox"
                  checked={useExistingBranch}
                  onChange={handleToggleUseExisting}
                  disabled={isBusy}
                />
                Usar branch Git existente no repositório
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
              type="submit"
              className="floor-btn floor-btn--primary"
              disabled={!isFormValid || isBusy}
            >
              {isBusy ? "Criando..." : "Criar Floor"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
