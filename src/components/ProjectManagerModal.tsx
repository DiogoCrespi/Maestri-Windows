import React from "react";
import type { RecentProject } from "../projectManager";

interface ProjectManagerModalProps {
  projects: readonly RecentProject[];
  projectName: string;
  busy: boolean;
  error: string | null;
  onProjectNameChange: (name: string) => void;
  onCreate: () => void;
  onOpen: () => void;
  onOpenRecent: (project: RecentProject) => void;
  onRemoveRecent: (project: RecentProject) => void;
  onRetry: () => void;
  onCancel?: () => void;
}

export const ProjectManagerModal: React.FC<ProjectManagerModalProps> = ({
  projects,
  projectName,
  busy,
  error,
  onProjectNameChange,
  onCreate,
  onOpen,
  onOpenRecent,
  onRemoveRecent,
  onRetry,
  onCancel,
}) => (
  <div
    role="dialog"
    aria-modal="true"
    aria-labelledby="project-manager-title"
    style={{ position: "fixed", inset: 0, zIndex: 1000, display: "grid", placeItems: "center", padding: 24, background: "rgba(0,0,0,.78)" }}
  >
    <section style={{ width: "min(680px, 100%)", maxHeight: "min(720px, 92vh)", overflow: "auto", padding: 28, border: "1px solid #3f3f46", borderRadius: 14, background: "#18181b", color: "#f4f4f5", boxShadow: "0 24px 80px rgba(0,0,0,.55)" }}>
      <h1 id="project-manager-title" style={{ marginTop: 0 }}>Gerenciador de Projetos</h1>
      <p style={{ color: "#a1a1aa" }}>Escolha um projeto para iniciar o Maestri. O projeto é uma pasta que contém <code>workspace.json</code>.</p>
      {error && (
        <div role="alert" style={{ margin: "14px 0", padding: 12, border: "1px solid #7f1d1d", borderRadius: 8, color: "#fecaca", background: "#450a0a" }}>
          <div>{error}</div>
          <button type="button" onClick={onRetry} disabled={busy} style={{ marginTop: 8 }}>Tentar novamente</button>
        </div>
      )}
      <div style={{ display: "grid", gap: 10, gridTemplateColumns: "1fr auto", margin: "20px 0" }}>
        <input
          aria-label="Nome do novo projeto"
          value={projectName}
          onChange={(event) => onProjectNameChange(event.target.value)}
          placeholder="Nome do projeto"
          disabled={busy}
          style={{ minWidth: 0, padding: "9px 10px", border: "1px solid #52525b", borderRadius: 7, background: "#09090b", color: "#f4f4f5" }}
        />
        <button type="button" onClick={onCreate} disabled={busy || !projectName.trim()}>Criar novo projeto</button>
        <button type="button" onClick={onOpen} disabled={busy} style={{ gridColumn: "1 / -1" }}>Abrir projeto…</button>
      </div>
      <h2 style={{ fontSize: 16 }}>Projetos recentes</h2>
      {projects.length === 0 ? (
        <p style={{ color: "#a1a1aa" }}>Nenhum projeto válido encontrado.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 8 }}>
          {projects.map((project) => (
            <li key={`${project.path}-${project.lastOpenedAt}`} style={{ display: "flex", gap: 8, alignItems: "center", padding: 10, border: "1px solid #27272a", borderRadius: 8 }}>
              <button type="button" onClick={() => onOpenRecent(project)} disabled={busy} style={{ flex: 1, minWidth: 0, textAlign: "left", background: "transparent", border: 0, color: "#f4f4f5", cursor: "pointer" }}>
                <strong style={{ display: "block" }}>{project.name}</strong>
                <small style={{ display: "block", color: "#a1a1aa", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{project.path}</small>
              </button>
              <button type="button" onClick={() => onRemoveRecent(project)} disabled={busy} aria-label={`Remover ${project.name} dos recentes`}>×</button>
            </li>
          ))}
        </ul>
      )}
      {busy && <p role="status" aria-live="polite" style={{ color: "#fbbf24" }}>Processando projeto…</p>}
      {onCancel && <button type="button" onClick={onCancel} disabled={busy} style={{ marginTop: 16 }}>Cancelar</button>}
    </section>
  </div>
);

export default ProjectManagerModal;
