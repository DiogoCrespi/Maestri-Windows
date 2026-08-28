export type AgentType = "claudeCode" | "codex" | "antGravity" | "genericShell";

export interface TerminalPreset {
  id: string;
  name: string;
  agentType: AgentType;
  command: string;
  args: string[];
  shellPath?: string;
  workingDirectory?: string;
  icon: string;
  color: string;
  env?: Record<string, string>;
  isBuiltIn: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRole {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  allowedActions: string[];
  presetId?: string;
  isBuiltIn: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SshPreferences {
  enabled: boolean;
  host: string;
  user: string;
  port: number;
  tunnelPort: number;
  scriptPath: string;
  addToPath: boolean;
}

export const DEFAULT_SSH_PREFERENCES: SshPreferences = {
  enabled: false,
  host: "",
  user: "",
  port: 22,
  tunnelPort: 7433,
  scriptPath: "~/.local/bin/omaestri",
  addToPath: true,
};

export interface PreferencesState {
  version: number;
  presets: TerminalPreset[];
  roles: AgentRole[];
  ssh: SshPreferences;
}

export const CURRENT_PREFERENCES_VERSION = 2;

export const PREFERENCES_LIMITS = {
  maxPresets: 100,
  maxRoles: 100,
  maxSerializedBytes: 2 * 1024 * 1024,
  id: 128,
  name: 128,
  command: 4096,
  args: 128,
  arg: 4096,
  shellPath: 4096,
  workingDirectory: 4096,
  icon: 128,
  color: 128,
  envEntries: 128,
  envKey: 128,
  envValue: 4096,
  description: 4096,
  systemPrompt: 16_384,
  allowedActions: 64,
  allowedAction: 128,
  timestamp: 64,
  sshHost: 253,
  sshUser: 64,
  sshScriptPath: 4096,
} as const;

export function validateSshPreferences(value: SshPreferences): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (typeof value.enabled !== "boolean") errors.push("SSH enabled must be a boolean");
  errors.push(...validateText(value.host, "SSH host", PREFERENCES_LIMITS.sshHost, value.enabled));
  errors.push(...validateText(value.user, "SSH user", PREFERENCES_LIMITS.sshUser, value.enabled));
  errors.push(...validateText(value.scriptPath, "SSH scriptPath", PREFERENCES_LIMITS.sshScriptPath, true));
  if (value.host && (value.host.startsWith("-") || value.host.includes("@") || /\s/.test(value.host)
    || !/^[A-Za-z0-9.:[\]%-]+$/.test(value.host))) {
    errors.push("SSH host contains unsupported characters");
  }
  if (value.user && (value.user.startsWith("-") || !/^[A-Za-z0-9_.-]+$/.test(value.user))) {
    errors.push("SSH user contains unsupported characters");
  }
  if (!(value.scriptPath.startsWith("~/") || value.scriptPath.startsWith("/"))
    || /[;|&`$<>'"\u0000-\u001f]/.test(value.scriptPath)) {
    errors.push("SSH scriptPath must be an absolute POSIX path without shell metacharacters");
  }
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) {
    errors.push("SSH port must be an integer between 1 and 65535");
  }
  if (!Number.isInteger(value.tunnelPort) || value.tunnelPort < 1 || value.tunnelPort > 65535) {
    errors.push("SSH tunnelPort must be an integer between 1 and 65535");
  }
  if (typeof value.addToPath !== "boolean") errors.push("SSH addToPath must be a boolean");
  return { valid: errors.length === 0, errors };
}

export const BUILTIN_PRESETS: TerminalPreset[] = [
  {
    id: "preset-claude-code",
    name: "Claude Code CLI",
    agentType: "claudeCode",
    command: "claude",
    args: [],
    icon: "terminal",
    color: "#8b5cf6",
    env: {},
    isBuiltIn: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "preset-codex",
    name: "OpenAI Codex CLI",
    agentType: "codex",
    command: "codex",
    args: [],
    icon: "code",
    color: "#10b981",
    env: {},
    isBuiltIn: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "preset-antgravity",
    name: "Antigravity CLI",
    agentType: "antGravity",
    command: "agy",
    args: [],
    icon: "zap",
    color: "#ec4899",
    env: {},
    isBuiltIn: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "preset-opencode",
    name: "OpenCode",
    agentType: "genericShell",
    command: "opencode",
    args: [],
    icon: "code",
    color: "#f59e0b",
    env: {},
    isBuiltIn: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "preset-generic-shell",
    name: "Generic Shell",
    agentType: "genericShell",
    command: "powershell.exe",
    args: ["-NoLogo"],
    icon: "shell",
    color: "#3b82f6",
    env: {},
    isBuiltIn: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
];

export const BUILTIN_ROLES: AgentRole[] = [
  {
    id: "role-code-architect",
    name: "Code Architect",
    description: "Responsible for structural refactoring, module design, and code quality",
    systemPrompt: "You are a senior software architect. Analyze codebase design and maintain modularity.",
    allowedActions: ["list", "check", "ask", "note:read", "note:write"],
    presetId: "preset-claude-code",
    isBuiltIn: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "role-test-engineer",
    name: "Test Engineer",
    description: "Focuses on automated unit tests, coverage, and regression prevention",
    systemPrompt: "You are a test engineer. Ensure high test coverage and robust assertion suites.",
    allowedActions: ["list", "check", "ask", "note:read"],
    presetId: "preset-codex",
    isBuiltIn: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "role-web-researcher",
    name: "Web & Portal Automation",
    description: "Interacts with web portals and documentation nodes via CLI commands",
    systemPrompt: "You automate web interactions via portal CLI commands.",
    allowedActions: ["list", "ask", "portal:inspect", "portal:click", "portal:fill", "portal:eval"],
    presetId: "preset-generic-shell",
    isBuiltIn: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
];

export function validatePreset(preset: Partial<TerminalPreset>): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  errors.push(...validateText(preset.name, "Preset name", PREFERENCES_LIMITS.name, true));
  errors.push(...validateText(preset.command, "Preset command", PREFERENCES_LIMITS.command, true));
  if (preset.agentType !== undefined) {
    if (typeof preset.agentType !== "string") errors.push("agentType must be a string");
    else if (!["claudeCode", "codex", "genericShell"].includes(preset.agentType)) errors.push("Invalid agentType");
  }
  errors.push(...validateOptionalText(preset.shellPath, "shellPath", PREFERENCES_LIMITS.shellPath));
  errors.push(...validateOptionalText(preset.workingDirectory, "workingDirectory", PREFERENCES_LIMITS.workingDirectory));
  errors.push(...validateOptionalText(preset.icon, "icon", PREFERENCES_LIMITS.icon));
  errors.push(...validateOptionalText(preset.color, "color", PREFERENCES_LIMITS.color));
  if (preset.args !== undefined) errors.push(...validateStringArray(preset.args, "args", PREFERENCES_LIMITS.args, PREFERENCES_LIMITS.arg));
  if (preset.env !== undefined) errors.push(...validateEnvironment(preset.env));
  return { valid: errors.length === 0, errors };
}

export function validateRole(role: Partial<AgentRole>): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  errors.push(...validateText(role.name, "Role name", PREFERENCES_LIMITS.name, true));
  errors.push(...validateText(role.systemPrompt, "Role systemPrompt", PREFERENCES_LIMITS.systemPrompt, true));
  errors.push(...validateOptionalText(role.description, "description", PREFERENCES_LIMITS.description));
  if (role.allowedActions !== undefined) {
    errors.push(...validateStringArray(role.allowedActions, "allowedActions", PREFERENCES_LIMITS.allowedActions, PREFERENCES_LIMITS.allowedAction));
  }
  errors.push(...validateOptionalText(role.presetId, "presetId", PREFERENCES_LIMITS.id));
  return { valid: errors.length === 0, errors };
}

function validateText(value: unknown, field: string, max: number, required: boolean): string[] {
  if (typeof value !== "string") return required || value !== undefined ? [`${field} must be a string`] : [];
  if (required && value.trim().length === 0) return [`${field} is required`];
  if (value.length > max) return [`${field} exceeds ${max} characters`];
  if ([...value].some((character) => character.charCodeAt(0) < 0x20)) {
    return [`${field} contains control characters`];
  }
  return [];
}

function validateOptionalText(value: unknown, field: string, max: number): string[] {
  return value === undefined ? [] : validateText(value, field, max, false);
}

function validateStringArray(value: unknown, field: string, maxItems: number, maxItemLength: number): string[] {
  if (!Array.isArray(value)) return [`${field} must be an array`];
  if (value.length > maxItems) return [`${field} exceeds ${maxItems} items`];
  return value.flatMap((item, index) => validateText(item, `${field}[${index}]`, maxItemLength, true));
}

function validateEnvironment(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["env must be an object"];
  const entries = Object.entries(value);
  if (entries.length > PREFERENCES_LIMITS.envEntries) return [`env exceeds ${PREFERENCES_LIMITS.envEntries} entries`];
  return entries.flatMap(([key, envValue]) => [
    ...validateText(key, "env key", PREFERENCES_LIMITS.envKey, true),
    ...validateText(envValue, `env[${key}]`, PREFERENCES_LIMITS.envValue, true),
  ]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateImportedCommon(record: Record<string, unknown>, index: number, kind: string): string[] {
  const prefix = `${kind}[${index}]`;
  const errors = [
    ...validateText(record.id, `${prefix}.id`, PREFERENCES_LIMITS.id, true),
    ...validateText(record.createdAt, `${prefix}.createdAt`, PREFERENCES_LIMITS.timestamp, true),
    ...validateText(record.updatedAt, `${prefix}.updatedAt`, PREFERENCES_LIMITS.timestamp, true),
  ];
  if (typeof record.isBuiltIn !== "boolean") errors.push(`${prefix}.isBuiltIn must be a boolean`);
  return errors;
}

export function validateImportedPreset(value: unknown, index = 0): { value?: TerminalPreset; errors: string[] } {
  if (!isRecord(value)) return { errors: [`presets[${index}] must be an object`] };
  const errors = [
    ...validateImportedCommon(value, index, "presets"),
    ...validateText(value.name, `presets[${index}].name`, PREFERENCES_LIMITS.name, true),
    ...validateText(value.command, `presets[${index}].command`, PREFERENCES_LIMITS.command, true),
    ...validateText(value.agentType, `presets[${index}].agentType`, PREFERENCES_LIMITS.id, true),
    ...validateText(value.icon, `presets[${index}].icon`, PREFERENCES_LIMITS.icon, true),
    ...validateText(value.color, `presets[${index}].color`, PREFERENCES_LIMITS.color, true),
    ...validateStringArray(value.args, `presets[${index}].args`, PREFERENCES_LIMITS.args, PREFERENCES_LIMITS.arg),
    ...validateOptionalText(value.shellPath, `presets[${index}].shellPath`, PREFERENCES_LIMITS.shellPath),
    ...validateOptionalText(value.workingDirectory, `presets[${index}].workingDirectory`, PREFERENCES_LIMITS.workingDirectory),
  ];
  if (!["claudeCode", "codex", "antGravity", "genericShell"].includes(String(value.agentType))) errors.push(`presets[${index}].agentType is invalid`);
  if (value.env !== undefined) errors.push(...validateEnvironment(value.env));
  if (errors.length > 0) return { errors };
  return {
    errors: [],
    value: {
      id: value.id as string,
      name: value.name as string,
      agentType: value.agentType as AgentType,
      command: value.command as string,
      args: [...(value.args as string[])],
      shellPath: value.shellPath as string | undefined,
      workingDirectory: value.workingDirectory as string | undefined,
      icon: value.icon as string,
      color: value.color as string,
      env: value.env === undefined ? {} : { ...(value.env as Record<string, string>) },
      isBuiltIn: value.isBuiltIn as boolean,
      createdAt: value.createdAt as string,
      updatedAt: value.updatedAt as string,
    },
  };
}

export function validateImportedRole(value: unknown, index = 0): { value?: AgentRole; errors: string[] } {
  if (!isRecord(value)) return { errors: [`roles[${index}] must be an object`] };
  const errors = [
    ...validateImportedCommon(value, index, "roles"),
    ...validateText(value.name, `roles[${index}].name`, PREFERENCES_LIMITS.name, true),
    ...validateText(value.description, `roles[${index}].description`, PREFERENCES_LIMITS.description, true),
    ...validateText(value.systemPrompt, `roles[${index}].systemPrompt`, PREFERENCES_LIMITS.systemPrompt, true),
    ...validateStringArray(value.allowedActions, `roles[${index}].allowedActions`, PREFERENCES_LIMITS.allowedActions, PREFERENCES_LIMITS.allowedAction),
    ...validateOptionalText(value.presetId, `roles[${index}].presetId`, PREFERENCES_LIMITS.id),
  ];
  if (errors.length > 0) return { errors };
  return {
    errors: [],
    value: {
      id: value.id as string,
      name: value.name as string,
      description: value.description as string,
      systemPrompt: value.systemPrompt as string,
      allowedActions: [...(value.allowedActions as string[])],
      presetId: value.presetId as string | undefined,
      isBuiltIn: value.isBuiltIn as boolean,
      createdAt: value.createdAt as string,
      updatedAt: value.updatedAt as string,
    },
  };
}
