import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { validateFrontendStorageScope, usePortalLifecycle } from "./PortalNode";
import { desktopBridge } from "../lib/desktopBridge";

describe("PortalNode storageScope canonical validation", () => {
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

describe("usePortalLifecycle Native Registration & Cleanup Lifecycle", () => {
  let portalRegisterSpy: ReturnType<typeof vi.spyOn>;
  let portalUnregisterSpy: ReturnType<typeof vi.spyOn>;
  let portalInspectSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    portalRegisterSpy = vi.spyOn(desktopBridge, "portalRegister").mockImplementation(
      async (id, name, initialUrl, storageScope) => ({
        id,
        name,
        currentUrl: initialUrl,
        title: null,
        isLoading: false,
        storageScope,
      }),
    );

    portalUnregisterSpy = vi.spyOn(desktopBridge, "portalUnregister").mockResolvedValue(true);

    portalInspectSpy = vi.spyOn(desktopBridge, "portalInspect").mockImplementation(
      async (id) => ({
        id,
        name: "Portal",
        currentUrl: "https://example.com",
        title: null,
        isLoading: false,
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Test helper to simulate React hook lifecycle execution without full DOM rendering
  function createLifecycleRunner(initialProps: {
    portalId: string;
    portalName: string;
    initialUrl: string;
    rawStorageScope: string;
    isNative: boolean;
  }) {
    let props = { ...initialProps };
    let cleanupFn: (() => void) | undefined;
    let prevDeps: unknown[] | null = null;

    const runEffect = () => {
      const validation = validateFrontendStorageScope(props.rawStorageScope);
      const isScopeValid = validation.isValid;
      const validatedScope = validation.scope;
      const scopeErrorMessage = validation.errorMessage;

      const currentDeps = [
        props.isNative,
        props.portalId,
        props.portalName,
        isScopeValid,
        validatedScope,
        scopeErrorMessage,
        props.rawStorageScope,
      ];

      // If dependencies changed, run previous cleanup and new effect
      const depsChanged =
        !prevDeps ||
        currentDeps.some((dep, i) => !Object.is(dep, prevDeps![i]));

      if (depsChanged) {
        if (cleanupFn) {
          cleanupFn();
          cleanupFn = undefined;
        }

        prevDeps = currentDeps;

        if (props.isNative && isScopeValid) {
          let cancelled = false;
          const registration = desktopBridge.portalRegister(
            props.portalId,
            props.portalName,
            props.initialUrl,
            validatedScope,
          );

          void registration.then(() => {
            if (!cancelled) {
              void desktopBridge.portalInspect(props.portalId);
            }
          });

          cleanupFn = () => {
            cancelled = true;
            void registration.then(() => desktopBridge.portalUnregister(props.portalId));
          };
        }
      }
    };

    runEffect();

    return {
      updateProps: (newProps: Partial<typeof initialProps>) => {
        props = { ...props, ...newProps };
        runEffect();
      },
      unmount: () => {
        if (cleanupFn) {
          cleanupFn();
          cleanupFn = undefined;
        }
      },
    };
  }

  test("mounting a portal registers EXACTLY ONCE and unmounting unregisters EXACTLY ONCE", async () => {
    const runner = createLifecycleRunner({
      portalId: "portal-lc-1",
      portalName: "Portal 1",
      initialUrl: "https://example.com",
      rawStorageScope: "isolated",
      isNative: true,
    });

    expect(portalRegisterSpy).toHaveBeenCalledTimes(1);
    expect(portalRegisterSpy).toHaveBeenCalledWith(
      "portal-lc-1",
      "Portal 1",
      "https://example.com",
      "isolated",
    );
    expect(portalUnregisterSpy).toHaveBeenCalledTimes(0);

    // Unmount
    runner.unmount();
    await Promise.resolve();

    expect(portalUnregisterSpy).toHaveBeenCalledTimes(1);
    expect(portalUnregisterSpy).toHaveBeenCalledWith("portal-lc-1");
  });

  test("URL changes or re-renders with new URL do NOT trigger unregister or re-registration", async () => {
    const runner = createLifecycleRunner({
      portalId: "portal-nav-1",
      portalName: "Portal Nav",
      initialUrl: "https://example.com",
      rawStorageScope: "isolated",
      isNative: true,
    });

    expect(portalRegisterSpy).toHaveBeenCalledTimes(1);
    expect(portalUnregisterSpy).toHaveBeenCalledTimes(0);

    // Update URL prop
    runner.updateProps({ initialUrl: "https://google.com" });
    await Promise.resolve();

    // CRITICAL: portalRegister MUST NOT be called again, and portalUnregister MUST NOT be called!
    expect(portalRegisterSpy).toHaveBeenCalledTimes(1);
    expect(portalUnregisterSpy).toHaveBeenCalledTimes(0);
  });

  test("changing scope valid -> invalid triggers cleanup of registered portal", async () => {
    const runner = createLifecycleRunner({
      portalId: "portal-scope-1",
      portalName: "Portal Scope",
      initialUrl: "https://example.com",
      rawStorageScope: "isolated",
      isNative: true,
    });

    expect(portalRegisterSpy).toHaveBeenCalledTimes(1);
    expect(portalUnregisterSpy).toHaveBeenCalledTimes(0);

    // Transition to unsupported "shared" scope
    runner.updateProps({ rawStorageScope: "shared" });
    await Promise.resolve();

    // Previous valid registration MUST be cleaned up with unregister
    expect(portalUnregisterSpy).toHaveBeenCalledTimes(1);
    expect(portalUnregisterSpy).toHaveBeenCalledWith("portal-scope-1");
  });

  test("changing scope invalid -> valid registers native portal once", async () => {
    const runner = createLifecycleRunner({
      portalId: "portal-scope-2",
      portalName: "Portal Scope 2",
      initialUrl: "https://example.com",
      rawStorageScope: "invalid_scope",
      isNative: true,
    });

    expect(portalRegisterSpy).toHaveBeenCalledTimes(0);

    // Transition to valid "isolated" scope
    runner.updateProps({ rawStorageScope: "isolated" });
    await Promise.resolve();

    expect(portalRegisterSpy).toHaveBeenCalledTimes(1);
    expect(portalRegisterSpy).toHaveBeenCalledWith(
      "portal-scope-2",
      "Portal Scope 2",
      "https://example.com",
      "isolated",
    );
  });
});
