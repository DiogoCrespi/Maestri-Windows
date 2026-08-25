import { describe, test, expect } from "vitest";
import { validateFrontendStorageScope } from "./PortalNode";

describe("PortalNode storageScope validation & session isolation contract", () => {
  test("default or empty scope resolves to isolated with incognito option", () => {
    const resEmpty = validateFrontendStorageScope("");
    expect(resEmpty.isValid).toBe(true);
    expect(resEmpty.scope).toBe("isolated");
    expect(resEmpty.webviewOptions).toEqual({ incognito: true });

    const resIsolated = validateFrontendStorageScope("isolated");
    expect(resIsolated.isValid).toBe(true);
    expect(resIsolated.scope).toBe("isolated");
    expect(resIsolated.webviewOptions).toEqual({ incognito: true });
  });

  test("valid shared scope with explicit group ID returns shared session dataDirectory", () => {
    const resSharedGroup = validateFrontendStorageScope("shared:group_abc123");
    expect(resSharedGroup.isValid).toBe(true);
    expect(resSharedGroup.scope).toBe("shared:group_abc123");
    expect(resSharedGroup.webviewOptions).toEqual({
      dataDirectory: "shared-sessions/group_abc123",
    });
  });

  test("plain 'shared' without group ID is rejected with explicit error", () => {
    const resPlainShared = validateFrontendStorageScope("shared");
    expect(resPlainShared.isValid).toBe(false);
    expect(resPlainShared.errorMessage).toContain(
      "requer grupo de sessão explícito",
    );
  });

  test("empty group ID in 'shared:' is rejected with explicit error", () => {
    const resEmptyGroup = validateFrontendStorageScope("shared:  ");
    expect(resEmptyGroup.isValid).toBe(false);
    expect(resEmptyGroup.errorMessage).toContain(
      "ID do grupo compartilhado não pode ser vazio",
    );
  });

  test("unsupported or unrecognized storageScope returns explicit error instead of pretending to isolate", () => {
    const resInvalid = validateFrontendStorageScope("workspace");
    expect(resInvalid.isValid).toBe(false);
    expect(resInvalid.errorMessage).toContain(
      'Escopo de armazenamento não suportado: "workspace"',
    );

    const resRandom = validateFrontendStorageScope("unknown_scope_123");
    expect(resRandom.isValid).toBe(false);
    expect(resRandom.errorMessage).toContain(
      'Escopo de armazenamento não suportado: "unknown_scope_123"',
    );
  });
});
