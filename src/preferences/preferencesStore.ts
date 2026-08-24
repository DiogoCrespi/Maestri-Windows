import {
  AgentRole,
  BUILTIN_PRESETS,
  BUILTIN_ROLES,
  CURRENT_PREFERENCES_VERSION,
  PREFERENCES_LIMITS,
  PreferencesState,
  TerminalPreset,
  validateImportedPreset,
  validateImportedRole,
  validatePreset,
  validateRole,
} from "./preferences";

const STORAGE_KEY = "maestri-preferences:v1";

function defaultPreferences(): PreferencesState {
  return {
    version: CURRENT_PREFERENCES_VERSION,
    presets: [...BUILTIN_PRESETS],
    roles: [...BUILTIN_ROLES],
  };
}

export function loadPreferencesFromStorage(storage: Storage = localStorage): PreferencesState {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) {
      return defaultPreferences();
    }
    if (raw.length > PREFERENCES_LIMITS.maxSerializedBytes) {
      throw new Error(`preferences JSON exceeds ${PREFERENCES_LIMITS.maxSerializedBytes} characters`);
    }
    const parsed: unknown = JSON.parse(raw);
    return migratePreferences(parsed);
  } catch (error) {
    console.error("Failed to load preferences from storage, fallback to defaults", error);
    return defaultPreferences();
  }
}

export function savePreferencesToStorage(state: PreferencesState, storage: Storage = localStorage): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    console.error("Failed to save preferences to storage", error);
  }
}

export function migratePreferences(data: unknown): PreferencesState {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Preferences document must be an object");
  }
  const record = data as Record<string, unknown>;
  const version = record.version === undefined ? 0 : record.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0 || version > CURRENT_PREFERENCES_VERSION) {
    throw new Error(`Unsupported preferences version: ${String(version)}`);
  }

  const rawPresets = record.presets === undefined ? [] : record.presets;
  const rawRoles = record.roles === undefined ? [] : record.roles;
  if (!Array.isArray(rawPresets)) throw new Error("presets must be an array");
  if (!Array.isArray(rawRoles)) throw new Error("roles must be an array");
  if (rawPresets.length > PREFERENCES_LIMITS.maxPresets) {
    throw new Error(`presets exceeds ${PREFERENCES_LIMITS.maxPresets} items`);
  }
  if (rawRoles.length > PREFERENCES_LIMITS.maxRoles) {
    throw new Error(`roles exceeds ${PREFERENCES_LIMITS.maxRoles} items`);
  }

  const errors: string[] = [];
  const presets: TerminalPreset[] = [];
  const roles: AgentRole[] = [];
  const presetIds = new Set<string>();
  const roleIds = new Set<string>();

  rawPresets.forEach((item, index) => {
    const result = validateImportedPreset(item, index);
    errors.push(...result.errors);
    if (result.value) {
      if (presetIds.has(result.value.id)) errors.push(`presets[${index}].id is duplicated`);
      presetIds.add(result.value.id);
      presets.push(result.value);
    }
  });

  rawRoles.forEach((item, index) => {
    const result = validateImportedRole(item, index);
    errors.push(...result.errors);
    if (result.value) {
      if (roleIds.has(result.value.id)) errors.push(`roles[${index}].id is duplicated`);
      roleIds.add(result.value.id);
      roles.push(result.value);
    }
  });

  for (const preset of presets) {
    const builtin = BUILTIN_PRESETS.find((item) => item.id === preset.id);
    if (builtin && JSON.stringify(preset) !== JSON.stringify(builtin)) {
      errors.push(`built-in preset '${preset.id}' does not match the canonical definition`);
    } else if (!builtin && preset.isBuiltIn) {
      errors.push(`custom preset '${preset.id}' cannot be marked built-in`);
    }
  }
  for (const role of roles) {
    const builtin = BUILTIN_ROLES.find((item) => item.id === role.id);
    if (builtin && JSON.stringify(role) !== JSON.stringify(builtin)) {
      errors.push(`built-in role '${role.id}' does not match the canonical definition`);
    } else if (!builtin && role.isBuiltIn) {
      errors.push(`custom role '${role.id}' cannot be marked built-in`);
    }
    if (role.presetId && !presetIds.has(role.presetId)) {
      errors.push(`role '${role.id}' references missing preset '${role.presetId}'`);
    }
  }
  if (errors.length > 0) throw new Error(errors.join("; "));

  for (const builtin of BUILTIN_PRESETS) {
    if (!presetIds.has(builtin.id)) presets.unshift(builtin);
  }
  for (const builtin of BUILTIN_ROLES) {
    if (!roleIds.has(builtin.id)) roles.unshift(builtin);
  }

  return { version: CURRENT_PREFERENCES_VERSION, presets, roles };
}

export interface PreferencesStoreActions {
  addPreset: (preset: Omit<TerminalPreset, "id" | "isBuiltIn" | "createdAt" | "updatedAt">) => TerminalPreset;
  updatePreset: (id: string, updates: Partial<Omit<TerminalPreset, "id" | "isBuiltIn">>) => boolean;
  deletePreset: (id: string) => boolean;
  addRole: (role: Omit<AgentRole, "id" | "isBuiltIn" | "createdAt" | "updatedAt">) => AgentRole;
  updateRole: (id: string, updates: Partial<Omit<AgentRole, "id" | "isBuiltIn">>) => boolean;
  deleteRole: (id: string) => boolean;
  exportJSON: () => string;
  importJSON: (jsonString: string) => { success: boolean; errors: string[] };
  resetToDefaults: () => void;
}

export type PreferencesStore = PreferencesState & PreferencesStoreActions;

const dummyMemoryStorage: Storage = {
  length: 0,
  clear: () => undefined,
  getItem: () => null,
  key: () => null,
  removeItem: () => undefined,
  setItem: () => undefined,
};

export function createPreferencesStore(
  initialState?: PreferencesState,
  storage: Storage = typeof localStorage !== "undefined" ? localStorage : dummyMemoryStorage,
) {
  let state: PreferencesState = initialState ?? loadPreferencesFromStorage(storage);

  const listeners = new Set<() => void>();

  const notify = () => {
    savePreferencesToStorage(state, storage);
    listeners.forEach((listener) => listener());
  };

  return {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    addPreset: (input: Omit<TerminalPreset, "id" | "isBuiltIn" | "createdAt" | "updatedAt">): TerminalPreset => {
      const validation = validatePreset(input);
      if (!validation.valid) {
        throw new Error(`Invalid preset: ${validation.errors.join(", ")}`);
      }
      const now = new Date().toISOString();
      const newPreset: TerminalPreset = {
        ...input,
        id: `preset-custom-${crypto.randomUUID()}`,
        args: input.args ?? [],
        env: input.env ?? {},
        isBuiltIn: false,
        createdAt: now,
        updatedAt: now,
      };
      state = {
        ...state,
        presets: [...state.presets, newPreset],
      };
      notify();
      return newPreset;
    },

    updatePreset: (id: string, updates: Partial<Omit<TerminalPreset, "id" | "isBuiltIn">>): boolean => {
      const existing = state.presets.find((p) => p.id === id);
      if (!existing || existing.isBuiltIn) return false;

      const merged = { ...existing, ...updates };
      const validation = validatePreset(merged);
      if (!validation.valid) {
        throw new Error(`Invalid preset update: ${validation.errors.join(", ")}`);
      }

      state = {
        ...state,
        presets: state.presets.map((p) =>
          p.id === id ? { ...merged, updatedAt: new Date().toISOString() } : p,
        ),
      };
      notify();
      return true;
    },

    deletePreset: (id: string): boolean => {
      const existing = state.presets.find((p) => p.id === id);
      if (!existing || existing.isBuiltIn) return false;

      state = {
        ...state,
        presets: state.presets.filter((p) => p.id !== id),
      };
      notify();
      return true;
    },

    addRole: (input: Omit<AgentRole, "id" | "isBuiltIn" | "createdAt" | "updatedAt">): AgentRole => {
      const validation = validateRole(input);
      if (!validation.valid) {
        throw new Error(`Invalid role: ${validation.errors.join(", ")}`);
      }
      const now = new Date().toISOString();
      const newRole: AgentRole = {
        ...input,
        id: `role-custom-${crypto.randomUUID()}`,
        allowedActions: input.allowedActions ?? [],
        isBuiltIn: false,
        createdAt: now,
        updatedAt: now,
      };
      state = {
        ...state,
        roles: [...state.roles, newRole],
      };
      notify();
      return newRole;
    },

    updateRole: (id: string, updates: Partial<Omit<AgentRole, "id" | "isBuiltIn">>): boolean => {
      const existing = state.roles.find((r) => r.id === id);
      if (!existing || existing.isBuiltIn) return false;

      const merged = { ...existing, ...updates };
      const validation = validateRole(merged);
      if (!validation.valid) {
        throw new Error(`Invalid role update: ${validation.errors.join(", ")}`);
      }

      state = {
        ...state,
        roles: state.roles.map((r) =>
          r.id === id ? { ...merged, updatedAt: new Date().toISOString() } : r,
        ),
      };
      notify();
      return true;
    },

    deleteRole: (id: string): boolean => {
      const existing = state.roles.find((r) => r.id === id);
      if (!existing || existing.isBuiltIn) return false;

      state = {
        ...state,
        roles: state.roles.filter((r) => r.id !== id),
      };
      notify();
      return true;
    },

    exportJSON: (): string => {
      return JSON.stringify(state, null, 2);
    },

    importJSON: (jsonString: string): { success: boolean; errors: string[] } => {
      const previousState = state;
      try {
        if (jsonString.length > PREFERENCES_LIMITS.maxSerializedBytes) {
          throw new Error(`preferences JSON exceeds ${PREFERENCES_LIMITS.maxSerializedBytes} characters`);
        }
        const parsed: unknown = JSON.parse(jsonString);
        const migrated = migratePreferences(parsed);
        state = migrated;
        notify();
        return { success: true, errors: [] };
      } catch (error) {
        state = previousState;
        const msg = error instanceof Error ? error.message : String(error);
        return { success: false, errors: [msg] };
      }
    },

    resetToDefaults: (): void => {
      state = {
        ...defaultPreferences(),
      };
      notify();
    },
  };
}
