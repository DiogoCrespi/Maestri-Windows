import { invoke } from "@tauri-apps/api/core";
import React, { useEffect, useState } from "react";
import { createPreferencesStore } from "../preferences/preferencesStore";
import { BUILTIN_PRESETS } from "../preferences/preferences";
import type { AgentRole, TerminalPreset } from "../preferences/preferences";
import "./TerminalSettings.css";

export interface ShellOption {
  id: string;
  name: string;
  path: string;
  isDefault: boolean;
}

export interface TerminalSettingsValue {
  name: string;
  shellPath: string;
  workingDirectory: string;
  isManager: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  assignedRoleId?: string | null;
  agentType?: string;
  color?: string;
  icon?: string;
}

export interface TerminalSettingsInitialValues {
  name?: string;
  shellPath?: string;
  workingDirectory?: string;
  isManager?: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  assignedRoleId?: string | null;
  agentType?: string;
  color?: string;
  icon?: string;
}

export type ShellLoader = () => Promise<readonly ShellOption[]>;

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PROTECTED_ENV_KEYS = new Set([
  "MAESTRI_TERMINAL_ID",
  "MAESTRI_SOCKET",
  "MAESTRI_TOKEN",
  "PATH",
  "TERM",
  "COLORTERM",
]);

export function isProtectedTerminalEnvKey(key: string): boolean {
  const normalized = key.trim().toUpperCase();
  return normalized.startsWith("MAESTRI_") || PROTECTED_ENV_KEYS.has(normalized);
}

export interface TerminalSettingsProps {
  initialValues?: TerminalSettingsInitialValues;
  onApply: (value: TerminalSettingsValue) => void | Promise<void>;
  onCancel?: () => void;
  loadShells?: ShellLoader;
  disabled?: boolean;
  title?: string;
}

const defaultLoadShells: ShellLoader = () => invoke<ShellOption[]>("shell_list");

function defaultShellPath(shells: readonly ShellOption[]): string {
  return shells.find((shell) => shell.isDefault)?.path ?? shells[0]?.path ?? "";
}

export function parseEnvString(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx <= 0) continue;

    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!ENV_KEY_PATTERN.test(key) || !val || isProtectedTerminalEnvKey(key)) continue;
    result[key] = val;
  }
  return result;
}

export function formatEnvString(env?: Record<string, string>): string {
  if (!env) return "";
  return Object.entries(env)
    .filter(([key, value]) =>
      ENV_KEY_PATTERN.test(key) && value.trim().length > 0 && !isProtectedTerminalEnvKey(key),
    )
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

/** Parse shell arguments without passing UI quotes to CommandBuilder. */
export function parseArgsString(raw: string): string[] {
  const args: string[] = [];
  const input = raw.trim();
  let token = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let tokenStarted = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];
    if (escaped) {
      token += char;
      escaped = false;
      tokenStarted = true;
      continue;
    }
    // Backslashes are literal in Windows paths. Only consume one when it is
    // clearly escaping a quote or another backslash.
    if (char === "\\" && quote !== "'" && (next === '"' || next === "\\")) {
      escaped = true;
      tokenStarted = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else token += char;
      tokenStarted = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      tokenStarted = true;
    } else if (/\s/.test(char)) {
      if (tokenStarted) {
        args.push(token);
        token = "";
        tokenStarted = false;
      }
    } else {
      token += char;
      tokenStarted = true;
    }
  }

  if (escaped) token += "\\";
  if (quote) throw new Error("Argumentos possuem aspas não fechadas.");
  if (tokenStarted) args.push(token);
  return args;
}

export const TerminalSettings: React.FC<TerminalSettingsProps> = ({
  initialValues,
  onApply,
  onCancel,
  loadShells = defaultLoadShells,
  disabled = false,
  title = "Configurações do terminal",
}) => {
  const [shells, setShells] = useState<readonly ShellOption[]>([]);
  const [shellPath, setShellPath] = useState(initialValues?.shellPath ?? "");
  const [name, setName] = useState(initialValues?.name ?? "");
  const [workingDirectory, setWorkingDirectory] = useState(initialValues?.workingDirectory ?? "");
  const [isManager, setIsManager] = useState(initialValues?.isManager ?? false);
  const [command, setCommand] = useState(initialValues?.command ?? "");
  const [argsStr, setArgsStr] = useState((initialValues?.args ?? []).join(" "));
  const [envStr, setEnvStr] = useState(formatEnvString(initialValues?.env));
  const [loadingShells, setLoadingShells] = useState(true);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    setLoadingShells(true);
    setError(null);

    void loadShells()
      .then((availableShells) => {
        if (!mounted) return;
        setShells(availableShells);
        setShellPath((current) => current || defaultShellPath(availableShells));
      })
      .catch((reason: unknown) => {
        if (!mounted) return;
        setError(`Não foi possível listar os shells: ${String(reason)}`);
      })
      .finally(() => {
        if (mounted) setLoadingShells(false);
      });

    return () => {
      mounted = false;
    };
  }, [loadShells]);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (disabled || applying) return;

    const trimmedName = name.trim();
    const trimmedWorkingDirectory = workingDirectory.trim();
    const trimmedShellPath = shellPath.trim();
    if (!trimmedName || !trimmedShellPath || !trimmedWorkingDirectory) {
      setError("Preencha o nome, o shell e o diretório de trabalho.");
      return;
    }

    let parsedArgs: string[];
    try {
      parsedArgs = parseArgsString(argsStr);
    } catch (reason: unknown) {
      setError(String(reason));
      return;
    }
    const parsedEnv = parseEnvString(envStr);

    setError(null);
    setApplying(true);
    try {
      await onApply({
        name: trimmedName,
        shellPath: trimmedShellPath,
        workingDirectory: trimmedWorkingDirectory,
        isManager,
        command: command.trim() || undefined,
        args: parsedArgs.length > 0 ? parsedArgs : undefined,
        env: Object.keys(parsedEnv).length > 0 ? parsedEnv : undefined,
        assignedRoleId: assignedRoleId || undefined,
        agentType: selectedAgentType || undefined,
        color: selectedColor || undefined,
        icon: selectedIcon || undefined,
      });
    } catch (reason: unknown) {
      setError(`Não foi possível aplicar as configurações: ${String(reason)}`);
    } finally {
      setApplying(false);
    }
  };

  const [selectedPresetId, setSelectedPresetId] = useState("");
  const [assignedRoleId, setAssignedRoleId] = useState(initialValues?.assignedRoleId ?? "");
  const [selectedAgentType, setSelectedAgentType] = useState(initialValues?.agentType ?? "");
  const [selectedColor, setSelectedColor] = useState(initialValues?.color ?? "");
  const [selectedIcon, setSelectedIcon] = useState(initialValues?.icon ?? "");

  const handlePresetSelect = (presetId: string) => {
    setSelectedPresetId(presetId);
    if (!presetId) return;
    const store = createPreferencesStore();
    const preset = store.getState().presets.find((p) => p.id === presetId);
    if (preset) {
      if (!name || name.startsWith("Terminal ") || BUILTIN_PRESETS.some((p) => p.name === name)) {
        setName(preset.name);
      }
      setCommand(preset.command);
      if (preset.args && preset.args.length > 0) {
        setArgsStr(preset.args.join(" "));
      } else {
        setArgsStr("");
      }
      setSelectedAgentType(preset.agentType);
      setSelectedColor(preset.color);
      setSelectedIcon(preset.icon);
    }
  };

  const handleRoleSelect = (roleId: string) => {
    setAssignedRoleId(roleId);
    if (!roleId) return;
    const store = createPreferencesStore();
    const role = store.getState().roles.find((r) => r.id === roleId);
    if (role && role.presetId) {
      handlePresetSelect(role.presetId);
    }
  };

  const preferences = createPreferencesStore().getState();

  const formDisabled = disabled || applying;
  const nameError = !name.trim();
  const directoryError = !workingDirectory.trim();
  const shellError = !shellPath && !loadingShells;

  return (
    <section
      className="terminal-settings nodrag nowheel"
      aria-labelledby="terminal-settings-title"
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <form onSubmit={(event) => void handleSubmit(event)}>
        <fieldset disabled={formDisabled}>
          <legend id="terminal-settings-title">{title}</legend>

          <div className="terminal-settings-grid">
            <label>Presets</label>
            <div className="terminal-settings-presets-grid" role="radiogroup" aria-label="Presets rápidos">
              {preferences.presets.map((preset: TerminalPreset) => {
                const isSelected = selectedPresetId === preset.id;
                const iconSymbol =
                  preset.icon === "zap" || preset.agentType === "antGravity" ? "⚡" :
                  preset.icon === "code" || preset.agentType === "codex" ? "💻" :
                  preset.agentType === "claudeCode" ? "🤖" : "🐚";
                return (
                  <button
                    key={preset.id}
                    type="button"
                    className={`terminal-preset-card ${isSelected ? "selected" : ""}`}
                    onClick={() => handlePresetSelect(isSelected ? "" : preset.id)}
                    title={`${preset.name} (${preset.command})`}
                    style={{ borderColor: isSelected ? preset.color : undefined }}
                  >
                    <span className="terminal-preset-icon" style={{ backgroundColor: `${preset.color}22`, color: preset.color }}>
                      {iconSymbol}
                    </span>
                    <span className="terminal-preset-name">{preset.name}</span>
                  </button>
                );
              })}
            </div>

            <label htmlFor="terminal-settings-role">Agent Role</label>
            <select
              id="terminal-settings-role"
              name="assignedRoleId"
              value={assignedRoleId}
              onChange={(e) => handleRoleSelect(e.target.value)}
            >
              <option value="">Nenhum role atribuído</option>
              {preferences.roles.map((role: AgentRole) => (
                <option key={role.id} value={role.id}>
                  {role.name}
                </option>
              ))}
            </select>

            <label htmlFor="terminal-settings-name">Nome</label>
            <input
              id="terminal-settings-name"
              name="name"
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Terminal principal"
              aria-invalid={nameError}
              aria-describedby={nameError ? "terminal-settings-error" : undefined}
              autoComplete="off"
            />

            <label htmlFor="terminal-settings-shell">Shell</label>
            <select
              id="terminal-settings-shell"
              name="shellPath"
              value={shellPath}
              onChange={(event) => setShellPath(event.target.value)}
              aria-busy={loadingShells}
              aria-invalid={shellError}
              aria-describedby={shellError ? "terminal-settings-error" : undefined}
            >
              <option value="">{loadingShells ? "Carregando shells…" : "Selecione um shell"}</option>
              {shells.map((shell) => (
                <option key={shell.id} value={shell.path}>
                  {shell.name}{shell.isDefault ? " (padrão)" : ""}
                </option>
              ))}
            </select>

            <label htmlFor="terminal-settings-working-directory">Diretório</label>
            <input
              id="terminal-settings-working-directory"
              name="workingDirectory"
              type="text"
              value={workingDirectory}
              onChange={(event) => setWorkingDirectory(event.target.value)}
              placeholder="C:\\Users\\..."
              aria-invalid={directoryError}
              aria-describedby={directoryError ? "terminal-settings-error" : undefined}
              autoComplete="off"
              spellCheck={false}
            />

            <label htmlFor="terminal-settings-manager">Papel</label>
            <label className="terminal-settings-checkbox">
              <input
                id="terminal-settings-manager"
                name="isManager"
                type="checkbox"
                checked={isManager}
                onChange={(event) => setIsManager(event.target.checked)}
              />
              <span>Maestro / Manager</span>
            </label>

            <label htmlFor="terminal-settings-command">Comando inicial</label>
            <input
              id="terminal-settings-command"
              name="command"
              type="text"
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              placeholder="Ex: claude ou pnpm dev (opcional)"
              autoComplete="off"
              spellCheck={false}
            />

            <label htmlFor="terminal-settings-args">Argumentos</label>
            <input
              id="terminal-settings-args"
              name="args"
              type="text"
              value={argsStr}
              onChange={(event) => setArgsStr(event.target.value)}
              placeholder="Ex: -NoProfile -NoLogo (args do shell)"
              autoComplete="off"
              spellCheck={false}
            />

            <label htmlFor="terminal-settings-env">Variáveis (ENV)</label>
            <textarea
              id="terminal-settings-env"
              name="env"
              rows={2}
              value={envStr}
              onChange={(event) => setEnvStr(event.target.value)}
              placeholder="CHOKIDAR_USEPOLLING=true&#10;NODE_ENV=development"
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          {error && (
            <p id="terminal-settings-error" className="terminal-settings-error" role="alert">
              {error}
            </p>
          )}

          <div className="terminal-settings-actions">
            <span className="terminal-settings-status" role="status" aria-live="polite">
              {loadingShells ? "Consultando shells…" : `${shells.length} shell${shells.length === 1 ? "" : "s"} disponível${shells.length === 1 ? "" : "eis"}`}
            </span>
            <div style={{ display: "flex", gap: "6px" }}>
              {onCancel && (
                <button
                  type="button"
                  className="terminal-settings-cancel-btn"
                  onClick={onCancel}
                  disabled={applying}
                >
                  Cancelar
                </button>
              )}
              <button type="submit" disabled={formDisabled || loadingShells || shells.length === 0}>
                {applying ? "Aplicando…" : "Aplicar"}
              </button>
            </div>
          </div>
        </fieldset>
      </form>
    </section>
  );
};

export default TerminalSettings;
