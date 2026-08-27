import React, { useEffect, useRef, useState } from "react";
import { AgentRole, AgentType, SshPreferences, TerminalPreset } from "../preferences/preferences";
import { createPreferencesStore } from "../preferences/preferencesStore";
import { desktopBridge, type SshConfig, type SshStatus } from "../lib/desktopBridge";
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
  const [tab, setTab] = useState<"presets" | "roles" | "ssh" | "io">("presets");
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

  const [sshDraft, setSshDraft] = useState<SshPreferences>(() => ({ ...activeStore.getState().ssh }));
  const [sshStatus, setSshStatus] = useState<SshStatus | null>(null);
  const [sshBusy, setSshBusy] = useState(false);

  // Import/Export state
  const [jsonText, setJsonText] = useState("");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const modalRef = useRef<HTMLDivElement | null>(null);
  const previousActiveElement = useRef<Element | null>(null);

  // Track dirty state of forms
  const isPresetFormDirty = Boolean(newPresetName.trim() || newPresetCommand.trim());
  const isRoleFormDirty = Boolean(newRoleName.trim() || newRolePrompt.trim());
  const isSshFormDirty = JSON.stringify(sshDraft) !== JSON.stringify(activeStore.getState().ssh);
  const isAnyFormDirty = isPresetFormDirty || isRoleFormDirty || isSshFormDirty;

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

  useEffect(() => {
    if (!isOpen) return;
    let active = true;
    setSshDraft({ ...activeStore.getState().ssh });
    const refreshStatus = () => {
      desktopBridge.sshStatus().then((status) => {
        if (active) setSshStatus(status);
      }).catch((error) => {
        if (active) setErrorMessage(`Não foi possível consultar o túnel SSH: ${String(error)}`);
      });
    };
    refreshStatus();
    const interval = window.setInterval(refreshStatus, 2_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [activeStore, isOpen]);

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

  const sshConfig = (): SshConfig => ({
    host: sshDraft.host.trim(),
    user: sshDraft.user.trim(),
    port: sshDraft.port,
    tunnelPort: sshDraft.tunnelPort,
    scriptPath: sshDraft.scriptPath.trim(),
    addToPath: sshDraft.addToPath,
  });

  const saveSshPreferences = () => {
    activeStore.updateSsh({ ...sshDraft, host: sshDraft.host.trim(), user: sshDraft.user.trim(), scriptPath: sshDraft.scriptPath.trim() });
    setSshDraft({ ...activeStore.getState().ssh });
    setRefresh((value) => value + 1);
  };

  const runSshAction = async (action: "save" | "install" | "connect" | "disconnect") => {
    setStatusMessage(null);
    setErrorMessage(null);
    setSshBusy(true);
    try {
      if (action === "disconnect") {
        const status = await desktopBridge.sshDisconnect();
        setSshStatus(status);
        setStatusMessage("Túnel SSH desconectado.");
        return;
      }
      saveSshPreferences();
      if (action === "save") {
        setStatusMessage("Configuração SSH salva.");
        return;
      }
      await desktopBridge.sshProbe();
      await desktopBridge.sshInstall(sshConfig());
      if (action === "install") {
        setStatusMessage(`Script remoto instalado em ${sshDraft.scriptPath}.`);
        return;
      }
      const status = await desktopBridge.sshConnect(sshConfig());
      setSshStatus(status);
      if (status.state !== "connected") throw new Error(status.message ?? "o túnel não foi estabelecido");
      setStatusMessage(`Túnel SSH conectado a ${sshDraft.user}@${sshDraft.host}.`);
    } catch (error) {
      setErrorMessage(`Falha SSH: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSshBusy(false);
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
          <h2 id="pref-dialog-title">Preferências do Maestri</h2>
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
            id="tab-ssh"
            type="button"
            role="tab"
            aria-selected={tab === "ssh"}
            aria-controls="panel-ssh"
            className={`preferences-tab-btn ${tab === "ssh" ? "active" : ""}`}
            onClick={() => setTab("ssh")}
          >
            Remote SSH
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

          {tab === "ssh" && (
            <div id="panel-ssh" role="tabpanel" aria-labelledby="tab-ssh">
              <form className="preferences-form" onSubmit={(event) => { event.preventDefault(); void runSshAction("save"); }}>
                <h3>Remote SSH</h3>
                <p className="preferences-help">
                  Instala um wrapper no host remoto e abre um túnel reverso limitado ao loopback remoto.
                  A primeira conexão aceita uma chave nova; alterações posteriores da chave são recusadas pelo OpenSSH.
                </p>
                <label className="preferences-checkbox" htmlFor="pref-ssh-enabled">
                  <input
                    id="pref-ssh-enabled"
                    type="checkbox"
                    checked={sshDraft.enabled}
                    disabled={sshBusy}
                    onChange={(event) => setSshDraft((value) => ({ ...value, enabled: event.target.checked }))}
                  />
                  Habilitar Remote SSH
                </label>
                <div className="preferences-field">
                  <label htmlFor="pref-ssh-host">Host</label>
                  <input id="pref-ssh-host" value={sshDraft.host} disabled={sshBusy} required
                    placeholder="server.example.com"
                    onChange={(event) => setSshDraft((value) => ({ ...value, host: event.target.value }))} />
                </div>
                <div className="preferences-field">
                  <label htmlFor="pref-ssh-user">Usuário</label>
                  <input id="pref-ssh-user" value={sshDraft.user} disabled={sshBusy} required
                    placeholder="developer"
                    onChange={(event) => setSshDraft((value) => ({ ...value, user: event.target.value }))} />
                </div>
                <div className="preferences-field preferences-inline-fields">
                  <label htmlFor="pref-ssh-port">Porta SSH
                    <input id="pref-ssh-port" type="number" min={1} max={65535} value={sshDraft.port} disabled={sshBusy}
                      onChange={(event) => setSshDraft((value) => ({ ...value, port: Number(event.target.value) }))} />
                  </label>
                  <label htmlFor="pref-ssh-tunnel-port">Porta remota do túnel
                    <input id="pref-ssh-tunnel-port" type="number" min={1} max={65535} value={sshDraft.tunnelPort} disabled={sshBusy}
                      onChange={(event) => setSshDraft((value) => ({ ...value, tunnelPort: Number(event.target.value) }))} />
                  </label>
                </div>
                <div className="preferences-field">
                  <label htmlFor="pref-ssh-script-path">Caminho remoto do script</label>
                  <input id="pref-ssh-script-path" value={sshDraft.scriptPath} disabled={sshBusy} required
                    onChange={(event) => setSshDraft((value) => ({ ...value, scriptPath: event.target.value }))} />
                </div>
                <label className="preferences-checkbox" htmlFor="pref-ssh-path">
                  <input id="pref-ssh-path" type="checkbox" checked={sshDraft.addToPath} disabled={sshBusy}
                    onChange={(event) => setSshDraft((value) => ({ ...value, addToPath: event.target.checked }))} />
                  Adicionar o diretório à variável PATH via ~/.profile (idempotente)
                </label>
                <div className="preferences-ssh-state" role="status" aria-live="polite">
                  Estado: {sshStatus?.state === "connected" ? `conectado (${sshStatus.host}:${sshStatus.port})` : "desconectado"}
                  {sshStatus?.message ? ` — ${sshStatus.message}` : ""}
                </div>
                <div className="preferences-actions">
                  <button type="submit" className="preferences-btn" disabled={sshBusy}>Salvar</button>
                  <button type="button" className="preferences-btn" disabled={sshBusy || !sshDraft.host.trim() || !sshDraft.user.trim()}
                    onClick={() => void runSshAction("install")}>Instalar script</button>
                  <button type="button" className="preferences-btn preferences-btn-primary"
                    disabled={sshBusy || !sshDraft.enabled || !sshDraft.host.trim() || !sshDraft.user.trim() || sshStatus?.state === "connected"}
                    onClick={() => void runSshAction("connect")}>Instalar e conectar</button>
                  <button type="button" className="preferences-btn preferences-btn-danger"
                    disabled={sshBusy || sshStatus?.state !== "connected"}
                    onClick={() => void runSshAction("disconnect")}>Desconectar</button>
                </div>
              </form>
            </div>
          )}

          {tab === "io" && (
            <div id="panel-io" role="tabpanel" aria-labelledby="tab-io">
              <h3>Importar e Exportar Configurações JSON</h3>
              <p style={{ fontSize: "12px", color: "#a1a1aa" }}>
                Você pode copiar a configuração atual ou colar um backup JSON para restaurar presets,
                roles e Remote SSH.
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
