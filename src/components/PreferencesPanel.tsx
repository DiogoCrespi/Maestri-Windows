import React, { useEffect, useRef, useState } from "react";
import { AgentRole, AgentType, TerminalPreset } from "../preferences/preferences";
import { createPreferencesStore } from "../preferences/preferencesStore";
import "./PreferencesPanel.css";

export interface PreferencesPanelProps {
  isOpen: boolean;
  onClose: () => void;
  store?: ReturnType<typeof createPreferencesStore>;
}

export const PreferencesPanel: React.FC<PreferencesPanelProps> = ({
  isOpen,
  onClose,
  store: customStore,
}) => {
  const [activeStore] = useState(() => customStore ?? createPreferencesStore());
  const [tab, setTab] = useState<"presets" | "roles" | "io">("presets");
  const [, setRefresh] = useState(0);

  // Form states for creating custom Preset
  const [newPresetName, setNewPresetName] = useState("");
  const [newPresetType, setNewPresetType] = useState<AgentType>("claudeCode");
  const [newPresetCommand, setNewPresetCommand] = useState("");
  const [newPresetColor, setNewPresetColor] = useState("#8b5cf6");

  // Form states for creating custom Role
  const [newRoleName, setNewRoleName] = useState("");
  const [newRoleDesc, setNewRoleDesc] = useState("");
  const [newRolePrompt, setNewRolePrompt] = useState("");
  const [newRolePresetId, setNewRolePresetId] = useState("");

  // Import/Export state
  const [jsonText, setJsonText] = useState("");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const modalRef = useRef<HTMLDivElement | null>(null);
  const previousActiveElement = useRef<Element | null>(null);

  // Track dirty state of forms
  const isPresetFormDirty = Boolean(newPresetName.trim() || newPresetCommand.trim());
  const isRoleFormDirty = Boolean(newRoleName.trim() || newRolePrompt.trim());
  const isAnyFormDirty = isPresetFormDirty || isRoleFormDirty;

  const handleClose = () => {
    if (isAnyFormDirty) {
      const confirmDiscard = window.confirm(
        "Existem alterações não salvas no formulário. Deseja realmente fechar?",
      );
      if (!confirmDiscard) return;
    }
    onClose();
  };

  // Focus management: store previous focus & restore on unmount/close
  useEffect(() => {
    if (isOpen) {
      previousActiveElement.current = document.activeElement;
      // Focus modal container or first focusable element
      setTimeout(() => {
        const firstInput = modalRef.current?.querySelector<HTMLElement>(
          "button, [href], input, select, textarea, [tabindex]:not([-tabindex='-1'])",
        );
        firstInput?.focus();
      }, 50);
    } else if (previousActiveElement.current instanceof HTMLElement) {
      previousActiveElement.current.focus();
    }
  }, [isOpen]);

  // Keyboard navigation: Escape key closes modal
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        handleClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, isAnyFormDirty]);

  if (!isOpen) return null;

  const state = activeStore.getState();

  const handleCreatePreset = (e: React.FormEvent) => {
    e.preventDefault();
    setStatusMessage(null);
    setErrorMessage(null);
    try {
      const created = activeStore.addPreset({
        name: newPresetName,
        agentType: newPresetType,
        command: newPresetCommand,
        args: [],
        icon: "terminal",
        color: newPresetColor,
        env: {},
      });
      setNewPresetName("");
      setNewPresetCommand("");
      setStatusMessage(`Preset "${created.name}" criado com sucesso.`);
      setRefresh((r) => r + 1);
    } catch (err) {
      setErrorMessage(`Erro ao criar preset: ${String(err)}`);
    }
  };

  const handleDeletePreset = (id: string, name: string) => {
    setStatusMessage(null);
    setErrorMessage(null);
    const confirmDelete = window.confirm(`Deseja excluir o preset "${name}"?`);
    if (!confirmDelete) return;

    if (activeStore.deletePreset(id)) {
      setStatusMessage(`Preset "${name}" excluído.`);
      setRefresh((r) => r + 1);
    } else {
      setErrorMessage(`Não foi possível excluir o preset "${name}".`);
    }
  };

  const handleCreateRole = (e: React.FormEvent) => {
    e.preventDefault();
    setStatusMessage(null);
    setErrorMessage(null);
    try {
      const created = activeStore.addRole({
        name: newRoleName,
        description: newRoleDesc,
        systemPrompt: newRolePrompt,
        allowedActions: ["list", "ask", "check"],
        presetId: newRolePresetId || undefined,
      });
      setNewRoleName("");
      setNewRoleDesc("");
      setNewRolePrompt("");
      setStatusMessage(`Agent Role "${created.name}" criado com sucesso.`);
      setRefresh((r) => r + 1);
    } catch (err) {
      setErrorMessage(`Erro ao criar role: ${String(err)}`);
    }
  };

  const handleDeleteRole = (id: string, name: string) => {
    setStatusMessage(null);
    setErrorMessage(null);
    const confirmDelete = window.confirm(`Deseja excluir o role "${name}"?`);
    if (!confirmDelete) return;

    if (activeStore.deleteRole(id)) {
      setStatusMessage(`Agent Role "${name}" excluído.`);
      setRefresh((r) => r + 1);
    } else {
      setErrorMessage(`Não foi possível excluir o role "${name}".`);
    }
  };

  const handleExport = () => {
    setStatusMessage(null);
    setErrorMessage(null);
    setJsonText(activeStore.exportJSON());
    setStatusMessage("JSON exportado para a caixa de texto.");
  };

  const handleImport = () => {
    setStatusMessage(null);
    setErrorMessage(null);
    if (!jsonText.trim()) {
      setErrorMessage("Cole o JSON no campo de texto antes de importar.");
      return;
    }
    const res = activeStore.importJSON(jsonText);
    if (res.success) {
      setStatusMessage("Preferências importadas com sucesso.");
      setRefresh((r) => r + 1);
    } else {
      setErrorMessage(`Erro na importação: ${res.errors.join(", ")}`);
    }
  };

  return (
    <div className="preferences-panel-overlay" onClick={handleClose}>
      <div
        ref={modalRef}
        className="preferences-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pref-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="preferences-panel-header">
          <h2 id="pref-dialog-title">Presets &amp; Roles do Terminal</h2>
          <button
            type="button"
            className="preferences-close-btn"
            onClick={handleClose}
            aria-label="Fechar painel de preferências"
          >
            ✕
          </button>
        </div>

        {/* Live Region for Screen Readers */}
        <div className="sr-only" aria-live="polite" aria-atomic="true">
          {statusMessage}
        </div>
        <div className="sr-only" aria-live="assertive" aria-atomic="true">
          {errorMessage}
        </div>

        {/* Visible status and error messages */}
        {statusMessage && (
          <div className="preferences-status-bar success" role="status">
            {statusMessage}
          </div>
        )}
        {errorMessage && (
          <div className="preferences-status-bar error" role="alert">
            {errorMessage}
          </div>
        )}

        <div className="preferences-tabs" role="tablist" aria-label="Abas de configuração">
          <button
            id="tab-presets"
            type="button"
            role="tab"
            aria-selected={tab === "presets"}
            aria-controls="panel-presets"
            className={`preferences-tab-btn ${tab === "presets" ? "active" : ""}`}
            onClick={() => setTab("presets")}
          >
            Presets ({state.presets.length})
          </button>
          <button
            id="tab-roles"
            type="button"
            role="tab"
            aria-selected={tab === "roles"}
            aria-controls="panel-roles"
            className={`preferences-tab-btn ${tab === "roles" ? "active" : ""}`}
            onClick={() => setTab("roles")}
          >
            Agent Roles ({state.roles.length})
          </button>
          <button
            id="tab-io"
            type="button"
            role="tab"
            aria-selected={tab === "io"}
            aria-controls="panel-io"
            className={`preferences-tab-btn ${tab === "io" ? "active" : ""}`}
            onClick={() => setTab("io")}
          >
            Importar / Exportar
          </button>
        </div>

        <div className="preferences-panel-body">
          {tab === "presets" && (
            <div id="panel-presets" role="tabpanel" aria-labelledby="tab-presets">
              <div className="preferences-list" aria-label="Lista de Presets">
                {state.presets.map((preset: TerminalPreset) => (
                  <div key={preset.id} className="preferences-item-card">
                    <div className="preferences-item-info">
                      <h4>
                        <span style={{ color: preset.color }} aria-hidden="true">
                          ●
                        </span>{" "}
                        {preset.name}{" "}
                        {preset.isBuiltIn && <span className="preferences-badge">Built-in</span>}
                      </h4>
                      <p>
                        Tipo: {preset.agentType} | Comando: <code>{preset.command}</code>
                      </p>
                    </div>
                    {!preset.isBuiltIn && (
                      <div className="preferences-actions">
                        <button
                          type="button"
                          className="preferences-btn preferences-btn-danger"
                          onClick={() => handleDeletePreset(preset.id, preset.name)}
                          aria-label={`Excluir preset ${preset.name}`}
                        >
                          Excluir
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>

              <form className="preferences-form" onSubmit={handleCreatePreset}>
                <h3>Novo Preset Customizado</h3>
                <div className="preferences-field">
                  <label htmlFor="pref-preset-name">Nome do Preset</label>
                  <input
                    id="pref-preset-name"
                    type="text"
                    value={newPresetName}
                    onChange={(e) => setNewPresetName(e.target.value)}
                    placeholder="Ex: Node.js Dev Agent"
                    required
                  />
                </div>
                <div className="preferences-field">
                  <label htmlFor="pref-preset-type">Tipo de Agente</label>
                  <select
                    id="pref-preset-type"
                    value={newPresetType}
                    onChange={(e) => setNewPresetType(e.target.value as AgentType)}
                  >
                    <option value="claudeCode">Claude Code CLI</option>
                    <option value="codex">OpenAI Codex</option>
                    <option value="genericShell">Generic Shell</option>
                  </select>
                </div>
                <div className="preferences-field">
                  <label htmlFor="pref-preset-cmd">Comando Inicial</label>
                  <input
                    id="pref-preset-cmd"
                    type="text"
                    value={newPresetCommand}
                    onChange={(e) => setNewPresetCommand(e.target.value)}
                    placeholder="Ex: node ou npx tsx"
                    required
                  />
                </div>
                <div className="preferences-field">
                  <label htmlFor="pref-preset-color">Cor de Identificação</label>
                  <input
                    id="pref-preset-color"
                    type="color"
                    value={newPresetColor}
                    onChange={(e) => setNewPresetColor(e.target.value)}
                  />
                </div>
                <button type="submit" className="preferences-btn preferences-btn-primary">
                  Adicionar Preset
                </button>
              </form>
            </div>
          )}

          {tab === "roles" && (
            <div id="panel-roles" role="tabpanel" aria-labelledby="tab-roles">
              <div className="preferences-list" aria-label="Lista de Agent Roles">
                {state.roles.map((role: AgentRole) => (
                  <div key={role.id} className="preferences-item-card">
                    <div className="preferences-item-info">
                      <h4>
                        {role.name}{" "}
                        {role.isBuiltIn && <span className="preferences-badge">Built-in</span>}
                      </h4>
                      <p>{role.description}</p>
                      <p>
                        <small>Prompt: {role.systemPrompt.slice(0, 60)}...</small>
                      </p>
                    </div>
                    {!role.isBuiltIn && (
                      <div className="preferences-actions">
                        <button
                          type="button"
                          className="preferences-btn preferences-btn-danger"
                          onClick={() => handleDeleteRole(role.id, role.name)}
                          aria-label={`Excluir role ${role.name}`}
                        >
                          Excluir
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>

              <form className="preferences-form" onSubmit={handleCreateRole}>
                <h3>Novo Agent Role</h3>
                <div className="preferences-field">
                  <label htmlFor="pref-role-name">Nome do Role</label>
                  <input
                    id="pref-role-name"
                    type="text"
                    value={newRoleName}
                    onChange={(e) => setNewRoleName(e.target.value)}
                    placeholder="Ex: Security Auditor"
                    required
                  />
                </div>
                <div className="preferences-field">
                  <label htmlFor="pref-role-desc">Descrição</label>
                  <input
                    id="pref-role-desc"
                    type="text"
                    value={newRoleDesc}
                    onChange={(e) => setNewRoleDesc(e.target.value)}
                    placeholder="Descrição curta"
                  />
                </div>
                <div className="preferences-field">
                  <label htmlFor="pref-role-prompt">System Prompt</label>
                  <textarea
                    id="pref-role-prompt"
                    rows={3}
                    value={newRolePrompt}
                    onChange={(e) => setNewRolePrompt(e.target.value)}
                    placeholder="Você é um auditor de segurança..."
                    required
                  />
                </div>
                <div className="preferences-field">
                  <label htmlFor="pref-role-preset-id">Preset Associado (Opcional)</label>
                  <select
                    id="pref-role-preset-id"
                    value={newRolePresetId}
                    onChange={(e) => setNewRolePresetId(e.target.value)}
                  >
                    <option value="">Nenhum preset específico</option>
                    {state.presets.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
                <button type="submit" className="preferences-btn preferences-btn-primary">
                  Adicionar Role
                </button>
              </form>
            </div>
          )}

          {tab === "io" && (
            <div id="panel-io" role="tabpanel" aria-labelledby="tab-io">
              <h3>Importar e Exportar Configurações JSON</h3>
              <p style={{ fontSize: "12px", color: "#a1a1aa" }}>
                Você pode copiar a configuração atual ou colar um backup JSON para restaurar presets
                e roles.
              </p>

              <div className="preferences-actions" style={{ marginBottom: "12px" }}>
                <button
                  type="button"
                  className="preferences-btn preferences-btn-primary"
                  onClick={handleExport}
                >
                  Gerar JSON Atual
                </button>
                <button type="button" className="preferences-btn" onClick={handleImport}>
                  Importar do Texto Abaixo
                </button>
              </div>

              <div className="preferences-field">
                <label htmlFor="pref-json-area">Conteúdo do JSON</label>
                <textarea
                  id="pref-json-area"
                  className="preferences-json-area"
                  value={jsonText}
                  onChange={(e) => setJsonText(e.target.value)}
                  placeholder="Cole o JSON de preferências aqui..."
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default PreferencesPanel;
