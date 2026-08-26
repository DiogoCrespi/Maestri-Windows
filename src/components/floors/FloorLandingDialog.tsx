import React, { useState, useEffect, useRef, useCallback } from "react";
import type { FloorItem, LandFloorInput } from "./types";
import "./FloorOverviewPanel.css";

export interface FloorLandingDialogProps {
  isOpen: boolean;
  floor: FloorItem | null;
  groundBranch: string;
  diffText?: string;
  isLoadingDiff?: boolean;
  isLanding?: boolean;
  error?: string | null;
  isSuccess?: boolean;
  onLand: (input: LandFloorInput) => Promise<void> | void;
  onCancel: () => void;
}

export const FloorLandingDialog: React.FC<FloorLandingDialogProps> = ({
  isOpen,
  floor,
  groundBranch,
  diffText = "",
  isLoadingDiff = false,
  isLanding = false,
  error = null,
  isSuccess = false,
  onLand,
  onCancel,
}) => {
  const [targetBranch, setTargetBranch] = useState(groundBranch || "main");
  const [localLanding, setLocalLanding] = useState(false);
  const submittingRef = useRef(false);

  useEffect(() => {
    if (isOpen) {
      setTargetBranch(groundBranch || "main");
      setLocalLanding(false);
      submittingRef.current = false;
    }
  }, [isOpen, groundBranch]);

  const isBusy = isLanding || localLanding;

  const handleLand = useCallback(async () => {
    if (!floor || submittingRef.current || isBusy || isSuccess) return;
    const trimmedTarget = targetBranch.trim();
    if (!trimmedTarget) return;

    submittingRef.current = true;
    setLocalLanding(true);
    try {
      await onLand({
        floorId: floor.id,
        targetBranch: trimmedTarget,
      });
    } finally {
      submittingRef.current = false;
      setLocalLanding(false);
    }
  }, [floor, isBusy, isSuccess, onLand, targetBranch]);

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
    <div className="floor-panel-overlay" data-testid="landing-dialog-overlay">
      <div
        className="floor-dialog"
        style={{ width: 520 }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="landing-dialog-title"
      >
        <div className="floor-panel__header">
          <h2 id="landing-dialog-title" className="floor-panel__title">
            ✈️ Landing: {floor.name}
          </h2>
          <button
            type="button"
            className="floor-panel__close-btn"
            onClick={onCancel}
            disabled={isBusy}
            aria-label="Fechar diálogo de landing"
          >
            ×
          </button>
        </div>

        <div className="floor-panel__body">
          <div className="floor-landing-target">
            <div>
              <div style={{ fontSize: 11, color: "#a1a1aa" }}>Floor Branch</div>
              <div style={{ fontWeight: 600, fontFamily: "monospace" }}>{floor.branchName}</div>
            </div>
            <div className="floor-landing-arrow">➔</div>
            <div style={{ flex: 1 }}>
              <label htmlFor="landing-target-branch" style={{ fontSize: 11, color: "#a1a1aa", display: "block" }}>
                Target Branch (Ground)
              </label>
              <input
                id="landing-target-branch"
                type="text"
                className="floor-input"
                style={{ marginTop: 2, width: "100%", boxSizing: "border-box" }}
                value={targetBranch}
                onChange={(e) => setTargetBranch(e.target.value)}
                disabled={isBusy || isSuccess}
                placeholder="ex: main"
              />
            </div>
          </div>

          <div className="floor-form-group">
            <label>Preview de Diff (--stat)</label>
            {isLoadingDiff ? (
              <div className="floor-diff-box" style={{ textAlign: "center", color: "#a1a1aa" }}>
                Carregando diff stat...
              </div>
            ) : (
              <div className="floor-diff-box">
                {diffText || "Sem alterações pendentes em relação ao target."}
              </div>
            )}
          </div>

          {error && (
            <div className="floor-panel__error" role="alert">
              ⚠️ {error}
            </div>
          )}

          {isSuccess && (
            <div
              style={{
                backgroundColor: "rgba(16, 185, 129, 0.15)",
                border: "1px solid rgba(16, 185, 129, 0.3)",
                color: "#6ee7b7",
                padding: "10px 12px",
                borderRadius: 8,
                fontSize: 13,
                marginBottom: 8,
              }}
              role="status"
            >
              ✓ Merge realizado com sucesso!
            </div>
          )}
        </div>

        <div className="floor-panel__footer">
          <button
            type="button"
            className="floor-btn"
            onClick={onCancel}
            disabled={isBusy}
          >
            {isSuccess ? "Fechar" : "Cancelar"}
          </button>

          <button
            type="button"
            className="floor-btn floor-btn--primary"
            onClick={handleLand}
            disabled={isBusy || isSuccess || !targetBranch.trim()}
          >
            {isLanding ? "Realizando Merge..." : isSuccess ? "Merge Concluído" : "Land & Merge"}
          </button>
        </div>
      </div>
    </div>
  );
};
