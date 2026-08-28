import React, { useState } from "react";
import type { RecentProject } from "../projectManager";
import "./Sidebar.css";

export interface SidebarProps {
  path: string;
  confirmedPath: string;
  isDirty: boolean;
  status: string;
  busy: boolean;
  recentProjects: RecentProject[];
  onPathChange: (newPath: string) => void;
  onOpenWorkspacePath: () => void;
  onNewWorkspace: () => void;
  onChooseAndOpenWorkspace: () => void;
  onSaveWorkspace: () => void;
  onSaveWorkspaceAs: () => void;
  onOpenProject: (projectPath: string) => void;
  onRemoveRecentProject: (projectPath: string) => void;
  onOpenProjectManager: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  path,
  confirmedPath,
  isDirty,
  status,
  busy,
  recentProjects,
  onPathChange,
  onOpenWorkspacePath,
  onNewWorkspace,
  onChooseAndOpenWorkspace,
  onSaveWorkspace,
  onSaveWorkspaceAs,
  onOpenProject,
  onRemoveRecentProject,
  onOpenProjectManager,
}) => {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <aside className={`app-sidebar ${collapsed ? "collapsed" : ""}`}>
      <button
        type="button"
        className="sidebar-toggle-btn"
        onClick={() => setCollapsed(!collapsed)}
        title={collapsed ? "Expandir barra lateral" : "Recolher barra lateral"}
        aria-label={collapsed ? "Expandir barra lateral" : "Recolher barra lateral"}
      >
        {collapsed ? "❯" : "❮"}
      </button>

      {!collapsed && (
        <div className="sidebar-content nodrag nowheel">
          {/* Active Workspace Section */}
          <div className="sidebar-section">
            <div className="sidebar-section-header">
              <span className="sidebar-section-title">Espaço Atual</span>
            </div>
            <input
              className="sidebar-path-input"
              aria-label="Caminho do workspace"
              value={path}
              onChange={(e) => onPathChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onOpenWorkspacePath();
              }}
              placeholder="Caminho do workspace.json..."
            />
            <div className="sidebar-actions-grid">
              <button
                type="button"
                className="sidebar-action-btn"
                disabled={busy}
                onClick={onNewWorkspace}
                title="Criar novo workspace em branco"
              >
                Novo espaço
              </button>
              <button
                type="button"
                className="sidebar-action-btn"
                disabled={busy}
                onClick={onChooseAndOpenWorkspace}
                title="Procurar e abrir workspace existente"
              >
                Abrir…
              </button>
              <button
                type="button"
                className="sidebar-action-btn primary"
                disabled={busy || !path.trim()}
                onClick={onSaveWorkspace}
                title="Salvar alterações do workspace"
              >
                Salvar{isDirty ? " *" : ""}
              </button>
              <button
                type="button"
                className="sidebar-action-btn"
                disabled={busy}
                onClick={onSaveWorkspaceAs}
                title="Salvar workspace em outro arquivo"
              >
                Salvar como…
              </button>
            </div>
          </div>

          {/* Status Message */}
          <div className="sidebar-status-bar" role="status" aria-live="polite" title={status}>
            <span className="sidebar-status-dot" style={{ backgroundColor: isDirty ? "#eab308" : "#10b981" }} />
            <span className="sidebar-status-text">{status}</span>
          </div>

          {/* Projects List Section */}
          <div className="sidebar-section projects-section">
            <div className="sidebar-section-header">
              <span className="sidebar-section-title">Projetos ({recentProjects.length})</span>
              <button
                type="button"
                className="sidebar-icon-link-btn"
                onClick={onOpenProjectManager}
                title="Gerenciar Projetos / Abrir outro"
              >
                ⚙
              </button>
            </div>

            <div className="sidebar-projects-list">
              {recentProjects.length === 0 ? (
                <div className="sidebar-empty-state">Nenhum projeto recente</div>
              ) : (
                recentProjects.map((project) => {
                  const isActive = Boolean(
                    confirmedPath && project.path && confirmedPath.toLowerCase().includes(project.path.toLowerCase()),
                  );
                  return (
                    <div
                      key={project.path}
                      className={`sidebar-project-item ${isActive ? "active" : ""}`}
                      onClick={() => onOpenProject(project.path)}
                      title={project.path}
                    >
                      <div className="sidebar-project-info">
                        <span className="sidebar-project-icon">📁</span>
                        <span className="sidebar-project-name">{project.name}</span>
                      </div>
                      <button
                        type="button"
                        className="sidebar-project-remove-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          onRemoveRecentProject(project.path);
                        }}
                        title="Remover do histórico"
                      >
                        ×
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}
    </aside>
  );
};
