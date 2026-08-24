import { describe, expect, it, vi } from "vitest";
import { BUILTIN_PRESETS, BUILTIN_ROLES } from "./preferences";
import { createPreferencesStore } from "./preferencesStore";

describe("Preferences Accessibility & Robustness Tests", () => {
  it("exports valid formatted JSON payload and validates empty or malformed imports safely", () => {
    const store = createPreferencesStore();
    const exported = store.exportJSON();
    expect(exported).toContain("preset-claude-code");
    expect(exported).toContain("role-code-architect");

    // Invalid JSON text
    const invalidRes = store.importJSON("{ invalid json }");
    expect(invalidRes.success).toBe(false);
    expect(invalidRes.errors.length).toBeGreaterThan(0);

    // Empty object migration fallback
    const emptyRes = store.importJSON("{}");
    expect(emptyRes.success).toBe(true);
    expect(store.getState().presets).toHaveLength(BUILTIN_PRESETS.length);
  });

  it("handles empty status and error messaging without throwing", () => {
    const store = createPreferencesStore();
    expect(() => store.resetToDefaults()).not.toThrow();
    expect(store.getState().presets).toHaveLength(BUILTIN_PRESETS.length);
    expect(store.getState().roles).toHaveLength(BUILTIN_ROLES.length);
  });
});
