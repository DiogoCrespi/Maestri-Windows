import { describe, test, expect } from "vitest";
import { validateFrontendStorageScope } from "./PortalNode";

describe("PortalNode storageScope canonical validation & session isolation contract", () => {
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

  test("canonical 'shared' value without edge session sharing is rejected with documented gap error", () => {
    const resShared = validateFrontendStorageScope("shared");
    expect(resShared.isValid).toBe(false);
    expect(resShared.errorMessage).toContain(
      "não é suportado no runtime Windows sem integração de edges portal-a-portal (lacuna documentada)",
    );
  });

  test("unsupported, non-canonical, or invented storageScope strings return explicit unsupported error", () => {
    const resInventedGroup = validateFrontendStorageScope("shared:group_abc123");
    expect(resInventedGroup.isValid).toBe(false);
    expect(resInventedGroup.errorMessage).toContain(
      'Escopo de armazenamento não suportado: "shared:group_abc123"',
    );

    const resInvalid = validateFrontendStorageScope("workspace");
    expect(resInvalid.isValid).toBe(false);
    expect(resInvalid.errorMessage).toContain(
      'Escopo de armazenamento não suportado: "workspace"',
    );
  });
});
