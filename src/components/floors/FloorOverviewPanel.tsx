import React, { useEffect, useRef } from "react";
import type { FloorItem } from "./types";
import { useDialogFocus } from "./controller";
import "./FloorOverviewPanel.css";

export interface FloorOverviewPanelProps {
  isOpen: boolean;
  floors: FloorItem[];
  groundBranch: string;
  selectedFloorId: string | null;
  isLoading?: boolean;
  errorMessage?: string | null;
  onSelectFloor: (floorId: string | null) => void;
  onCreateFloorClick: () => void;
  onConfigureHooksClick: (floor: FloorItem) => void;
  onLandFloorClick: (floor: FloorItem) => void;
  onDeleteFloorClick: (floor: FloorItem) => void;
  onClose?: () => void;
}

export const FloorOverviewPanel: React.FC<FloorOverviewPanelProps> = ({
  isOpen,
  floors,
  groundBranch,
  selectedFloorId,
  isLoading = false,
  errorMessage = null,
  onSelectFloor,
  onCreateFloorClick,
  onConfigureHooksClick,
  onLandFloorClick,
  onDeleteFloorClick,
  onClose,
}) => {
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  useDialogFocus(isOpen, closeBtnRef);

  useEffect(() => {
    if (!isOpen || !onClose) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isLoading) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, isLoading, onClose]);

  if (!isOpen) return null;

  const isGroundSelected = selectedFloorId === null || selectedFloorId === "ground";

  return (
    <div className="floor-panel-overlay" data-testid="floor-overview-overlay">
      <div
        className="floor-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="floor-overview-title"
      >
        <div className="floor-panel__header">
          <h2 id="floor-overview-title" className="floor-panel__title">
            <span>🏢</span> Work Floors & Branches
          </h2>
          {onClose && (
            <button
              ref={closeBtnRef}
              type="button"
              className="floor-panel__close-btn"
              onClick={onClose}
              disabled={isLoading}
              aria-label="Fechar painel de floors"
            >
              ×
            </button>
          )}
        </div>

        <div className="floor-panel__body">
          {errorMessage && (
            <div className="floor-panel__error" role="alert">
              ⚠️ {errorMessage}
            </div>
          )}

          <div className="floor-panel__list" role="listbox" aria-label="Lista de Floors">
            {/* Ground Floor (Always Present) */}
            <div
              className={`floor-row floor-row--ground ${isGroundSelected ? "floor-row--active" : ""}`}
              onClick={() => !isLoading && onSelectFloor(null)}
              role="option"
              tabIndex={0}
              aria-selected={isGroundSelected}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  !isLoading && onSelectFloor(null);
                }
              }}
            >
              <div className="floor-row__info">
                <div className="floor-row__radio">
                  {isGroundSelected && <div className="floor-row__radio-inner" />}
                </div>
                <div className="floor-row__details">
                  <div className="floor-row__name">
                    Ground Floor
                    <span className="floor-row__badge">Main Workspace</span>
                  </div>
                  <div className="floor-row__branch">branch: {groundBranch || "main"}</div>
                </div>
              </div>
            </div>

            {/* Created Floors List */}
            {floors.map((floor) => {
              const isSelected = selectedFloorId === floor.id;
              return (
                <div
                  key={floor.id}
                  className={`floor-row ${isSelected ? "floor-row--active" : ""}`}
                  onClick={() => !isLoading && onSelectFloor(floor.id)}
                  role="option"
                  tabIndex={0}
                  aria-selected={isSelected}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      !isLoading && onSelectFloor(floor.id);
                    }
                  }}
                >
                  <div className="floor-row__info">
                    <div className="floor-row__radio">
                      {isSelected && <div className="floor-row__radio-inner" />}
                    </div>
                    <div className="floor-row__details">
                      <div className="floor-row__name">{floor.name}</div>
                      <div className="floor-row__branch">branch: {floor.branchName}</div>
                    </div>
                  </div>

                  <div className="floor-row__actions" onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      className="floor-btn"
                      onClick={() => onLandFloorClick(floor)}
                      disabled={isLoading}
                      aria-label={`Land floor ${floor.name}`}
                    >
                      ✈️ Land
                    </button>

                    <button
                      type="button"
                      className="floor-btn"
                      onClick={() => onConfigureHooksClick(floor)}
                      disabled={isLoading}
                      aria-label={`Configurar hooks do floor ${floor.name}`}
                    >
                      ⚡ Hooks
                    </button>

                    <button
                      type="button"
                      className="floor-btn floor-btn--danger"
                      onClick={() => onDeleteFloorClick(floor)}
                      disabled={isLoading}
                      aria-label={`Excluir floor ${floor.name}`}
                    >
                      🗑️
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="floor-panel__footer">
          <button
            type="button"
            className="floor-btn floor-btn--primary"
            onClick={onCreateFloorClick}
            disabled={isLoading}
          >
            + Novo Floor
          </button>
        </div>
      </div>
    </div>
  );
};
