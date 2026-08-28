import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUILTIN_PRESETS,
  BUILTIN_ROLES,
  CURRENT_PREFERENCES_VERSION,
  DEFAULT_SSH_PREFERENCES,
  PREFERENCES_LIMITS,
  validatePreset,
  validateRole,
  validateSshPreferences,
} from "./preferences";
import { createPreferencesStore, loadPreferencesFromStorage, migratePreferences } from "./preferencesStore";

class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length() {
    return this.store.size;
  }
  clear() {
    this.store.clear();
  }
  getItem(key: string) {
    return this.store.get(key) ?? null;
  }
  key(index: number) {
    return Array.from(this.store.keys())[index] ?? null;
  }
  removeItem(key: string) {
    this.store.delete(key);
  }
  setItem(key: string, value: string) {
    this.store.set(key, value);
  }
}

describe("Preferences Model & Built-ins", () => {
  it("includes Claude Code, Codex, Antigravity, OpenCode and generic shell built-in presets", () => {
    expect(BUILTIN_PRESETS).toHaveLength(5);
    expect(BUILTIN_PRESETS.map((p) => p.agentType)).toEqual(["claudeCode", "codex", "antGravity", "genericShell", "genericShell"]);
    expect(BUILTIN_PRESETS.every((p) => p.isBuiltIn)).toBe(true);
  });

  it("includes built-in roles associated with presets", () => {
    expect(BUILTIN_ROLES).toHaveLength(3);
    expect(BUILTIN_ROLES.map((r) => r.name)).toContain("Code Architect");
    expect(BUILTIN_ROLES.every((r) => r.isBuiltIn)).toBe(true);
  });

  it("validates presets accurately", () => {
    expect(validatePreset({ name: "Test", command: "cmd", agentType: "claudeCode" }).valid).toBe(true);
    expect(validatePreset({ name: "", command: "cmd" }).valid).toBe(false);
    expect(validatePreset({ name: "Test", command: "" }).valid).toBe(false);
  });

  it("validates roles accurately", () => {
    expect(validateRole({ name: "Role A", systemPrompt: "Prompt A" }).valid).toBe(true);
    expect(validateRole({ name: "", systemPrompt: "Prompt A" }).valid).toBe(false);
    expect(validateRole({ name: "Role A", systemPrompt: "" }).valid).toBe(false);
  });
});

describe("PreferencesStore CRUD & Persistence", () => {
  let memoryStorage: MemoryStorage;

  beforeEach(() => {
    memoryStorage = new MemoryStorage();
  });

  it("initializes with built-ins if storage is empty", () => {
    const store = createPreferencesStore(undefined, memoryStorage);
    const state = store.getState();
    expect(state.presets).toHaveLength(BUILTIN_PRESETS.length);
    expect(state.roles).toHaveLength(BUILTIN_ROLES.length);
  });

  it("allows adding custom presets and roles with auto UUID", () => {
    const store = createPreferencesStore(undefined, memoryStorage);
    const preset = store.addPreset({
      name: "Custom Node Agent",
      agentType: "genericShell",
      command: "node",
      args: ["agent.js"],
      icon: "code",
      color: "#ff0000",
    });

    expect(preset.id).toMatch(/^preset-custom-/);
    expect(preset.isBuiltIn).toBe(false);
    expect(store.getState().presets.map((p) => p.id)).toContain(preset.id);

    const role = store.addRole({
      name: "Node Specialist",
      description: "Handles node execution",
      systemPrompt: "Run node scripts safely",
      allowedActions: ["list", "ask"],
      presetId: preset.id,
    });

    expect(role.id).toMatch(/^role-custom-/);
    expect(role.isBuiltIn).toBe(false);
    expect(store.getState().roles.map((r) => r.id)).toContain(role.id);
  });

  it("prevents modifying or deleting built-ins", () => {
    const store = createPreferencesStore(undefined, memoryStorage);
    const builtinPresetId = BUILTIN_PRESETS[0].id;
    const builtinRoleId = BUILTIN_ROLES[0].id;

    expect(store.updatePreset(builtinPresetId, { name: "Renamed" })).toBe(false);
    expect(store.deletePreset(builtinPresetId)).toBe(false);
    expect(store.updateRole(builtinRoleId, { name: "Renamed" })).toBe(false);
    expect(store.deleteRole(builtinRoleId)).toBe(false);
  });

  it("supports updates and deletion for custom items", () => {
    const store = createPreferencesStore(undefined, memoryStorage);
    const customPreset = store.addPreset({
      name: "Temp Preset",
      agentType: "genericShell",
      command: "bash",
      args: [],
      icon: "terminal",
      color: "#00ff00",
    });

    expect(store.updatePreset(customPreset.id, { name: "Updated Preset" })).toBe(true);
    expect(store.getState().presets.find((p) => p.id === customPreset.id)?.name).toBe("Updated Preset");

    expect(store.deletePreset(customPreset.id)).toBe(true);
    expect(store.getState().presets.find((p) => p.id === customPreset.id)).toBeUndefined();
  });

  it("exports and imports JSON state with version migration", () => {
    const store1 = createPreferencesStore(undefined, memoryStorage);
    store1.addPreset({
      name: "Exported Agent",
      agentType: "claudeCode",
      command: "claude",
      args: ["--mode", "batch"],
      icon: "terminal",
      color: "#000",
    });

    const json = store1.exportJSON();
    expect(json).toContain("Exported Agent");

    const store2 = createPreferencesStore(undefined, memoryStorage);
    const result = store2.importJSON(json);
    expect(result.success).toBe(true);
    expect(store2.getState().presets.some((p) => p.name === "Exported Agent")).toBe(true);
  });

  it("migrates unversioned or legacy data by retaining built-ins", () => {
    const legacyData = {
      presets: [
        {
          id: "custom-old",
          name: "Old Custom",
          agentType: "genericShell" as const,
          command: "cmd.exe",
          args: [],
          icon: "shell",
          color: "#000",
          isBuiltIn: false,
          createdAt: "2025-01-01",
          updatedAt: "2025-01-01",
        },
      ],
    };

    const migrated = migratePreferences(legacyData);
    expect(migrated.version).toBe(CURRENT_PREFERENCES_VERSION);
    expect(migrated.presets.some((p) => p.id === "custom-old")).toBe(true);
    expect(migrated.presets.some((p) => p.id === "preset-claude-code")).toBe(true);
    expect(migrated.ssh).toEqual(DEFAULT_SSH_PREFERENCES);
  });

  it("migrates, validates, updates and persists Remote SSH preferences", () => {
    const store = createPreferencesStore(undefined, memoryStorage);
    store.updateSsh({
      enabled: true,
      host: "build.example.test",
      user: "developer",
      tunnelPort: 17433,
    });

    expect(store.getState().ssh).toMatchObject({
      enabled: true,
      host: "build.example.test",
      user: "developer",
      port: 22,
      tunnelPort: 17433,
      scriptPath: "~/.local/bin/omaestri",
    });
    expect(loadPreferencesFromStorage(memoryStorage).ssh).toEqual(store.getState().ssh);
    expect(() => store.updateSsh({ port: 0 })).toThrow("between 1 and 65535");
    expect(validateSshPreferences({ ...DEFAULT_SSH_PREFERENCES, tunnelPort: 65536 }).valid).toBe(false);
  });

  it("rejects invalid imported items without replacing the current state", () => {
    const store = createPreferencesStore(undefined, memoryStorage);
    store.addPreset({
      name: "Keep me",
      agentType: "genericShell",
      command: "cmd.exe",
      args: [],
      icon: "terminal",
      color: "#000",
    });
    const before = JSON.stringify(store.getState());
    const imported = JSON.parse(store.exportJSON()) as { presets: Array<Record<string, unknown>> };
    imported.presets[0].name = "bad\nname";

    const result = store.importJSON(JSON.stringify(imported));

    expect(result.success).toBe(false);
    expect(result.errors.join(" ")).toContain("control characters");
    expect(JSON.stringify(store.getState())).toBe(before);
  });

  it("rejects unsupported versions, wrong types, duplicate IDs and oversized collections", () => {
    const store = createPreferencesStore(undefined, memoryStorage);
    const before = JSON.stringify(store.getState());

    expect(store.importJSON(JSON.stringify({ version: 99, presets: [], roles: [] })).success).toBe(false);
    expect(store.importJSON(JSON.stringify({ version: 1, presets: {}, roles: [] })).success).toBe(false);

    const duplicate = {
      version: 1,
      presets: [BUILTIN_PRESETS[0], BUILTIN_PRESETS[0]],
      roles: [],
    };
    expect(store.importJSON(JSON.stringify(duplicate)).success).toBe(false);

    const oversized = {
      version: 1,
      presets: Array.from({ length: PREFERENCES_LIMITS.maxPresets + 1 }, () => BUILTIN_PRESETS[0]),
      roles: [],
    };
    expect(store.importJSON(JSON.stringify(oversized)).success).toBe(false);
    expect(JSON.stringify(store.getState())).toBe(before);
  });

  it("validates imported field types and preserves optional legacy defaults", () => {
    const store = createPreferencesStore(undefined, memoryStorage);
    const legacyPreset = {
      id: "custom-legacy",
      name: "Legacy",
      agentType: "genericShell",
      command: "cmd.exe",
      args: [],
      icon: "terminal",
      color: "#000",
      isBuiltIn: false,
      createdAt: "2025-01-01",
      updatedAt: "2025-01-01",
    };
    const valid = store.importJSON(JSON.stringify({ presets: [legacyPreset], roles: [] }));
    expect(valid.success).toBe(true);
    expect(store.getState().presets.find((preset) => preset.id === "custom-legacy")?.env).toEqual({});

    const before = JSON.stringify(store.getState());
    const invalid = { version: 1, presets: [{ ...legacyPreset, args: [42] }], roles: [] };
    expect(store.importJSON(JSON.stringify(invalid)).success).toBe(false);
    expect(JSON.stringify(store.getState())).toBe(before);
  });
});
