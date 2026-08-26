import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import {
  validateFrontendStorageScope,
  PortalLifecycleController,
} from "./PortalNode";
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

    const resWhitespace = validateFrontendStorageScope("  isolated  ");
    expect(resWhitespace.isValid).toBe(true);
    expect(resWhitespace.scope).toBe("isolated");
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

describe("PortalLifecycleController Native Registration & Cleanup Lifecycle", () => {
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

  test("mount registers EXACTLY ONCE and unmount unregisters EXACTLY ONCE", async () => {
    const controller = new PortalLifecycleController({
      portalId: "portal-ctrl-1",
      portalName: "Portal 1",
      initialUrl: "https://example.com",
      rawStorageScope: "isolated",
      isNative: true,
      bridge: desktopBridge,
    });

    const val = controller.mount();
    expect(val.isValid).toBe(true);
    expect(portalRegisterSpy).toHaveBeenCalledTimes(1);
    expect(portalRegisterSpy).toHaveBeenCalledWith(
      "portal-ctrl-1",
      "Portal 1",
      "https://example.com",
      "isolated",
    );
    expect(portalUnregisterSpy).toHaveBeenCalledTimes(0);

    // Unmount
    controller.unmount();
    await Promise.resolve();
    await Promise.resolve();

    expect(portalUnregisterSpy).toHaveBeenCalledTimes(1);
    expect(portalUnregisterSpy).toHaveBeenCalledWith("portal-ctrl-1");
  });

  test("updating URL or portalName does NOT trigger unregister or re-registration", async () => {
    const controller = new PortalLifecycleController({
      portalId: "portal-ctrl-nav",
      portalName: "Portal Nav",
      initialUrl: "https://example.com",
      rawStorageScope: "isolated",
      isNative: true,
      bridge: desktopBridge,
    });

    controller.mount();
    expect(portalRegisterSpy).toHaveBeenCalledTimes(1);
    expect(portalUnregisterSpy).toHaveBeenCalledTimes(0);

    // Update URL or portalName
    controller.update({ initialUrl: "https://google.com", portalName: "Renamed Portal" });
    await Promise.resolve();
    await Promise.resolve();

    // CRITICAL: portalRegister MUST NOT be called again, and portalUnregister MUST NOT be called!
    expect(portalRegisterSpy).toHaveBeenCalledTimes(1);
    expect(portalUnregisterSpy).toHaveBeenCalledTimes(0);
  });

  test("whitespace differences in rawStorageScope ('isolated' vs ' isolated ') do NOT re-register or unregister", async () => {
    const controller = new PortalLifecycleController({
      portalId: "portal-ctrl-whitespace",
      portalName: "Portal Whitespace",
      initialUrl: "https://example.com",
      rawStorageScope: "isolated",
      isNative: true,
      bridge: desktopBridge,
    });

    controller.mount();
    expect(portalRegisterSpy).toHaveBeenCalledTimes(1);
    expect(portalUnregisterSpy).toHaveBeenCalledTimes(0);

    // Update rawStorageScope with extra whitespace
    controller.update({ rawStorageScope: " isolated " });
    await Promise.resolve();
    await Promise.resolve();

    expect(portalRegisterSpy).toHaveBeenCalledTimes(1);
    expect(portalUnregisterSpy).toHaveBeenCalledTimes(0);
  });

  test("changing portalId unregisters old ID and registers new ID cleanly", async () => {
    const controller = new PortalLifecycleController({
      portalId: "portal-id-1",
      portalName: "Portal Identity",
      initialUrl: "https://example.com",
      rawStorageScope: "isolated",
      isNative: true,
      bridge: desktopBridge,
    });

    controller.mount();
    expect(portalRegisterSpy).toHaveBeenCalledTimes(1);
    expect(portalRegisterSpy).toHaveBeenCalledWith("portal-id-1", "Portal Identity", "https://example.com", "isolated");

    // Change portalId
    controller.update({ portalId: "portal-id-2" });
    await Promise.resolve();
    await Promise.resolve();

    // Old ID must be unregistered, and new ID must be registered
    expect(portalUnregisterSpy).toHaveBeenCalledWith("portal-id-1");
    expect(portalRegisterSpy).toHaveBeenCalledWith("portal-id-2", "Portal Identity", "https://example.com", "isolated");
  });

  test("changing scope valid -> invalid triggers cleanup of registered portal", async () => {
    const controller = new PortalLifecycleController({
      portalId: "portal-ctrl-scope-1",
      portalName: "Portal Scope 1",
      initialUrl: "https://example.com",
      rawStorageScope: "isolated",
      isNative: true,
      bridge: desktopBridge,
    });

    controller.mount();
    expect(portalRegisterSpy).toHaveBeenCalledTimes(1);
    expect(portalUnregisterSpy).toHaveBeenCalledTimes(0);

    // Transition to unsupported "shared" scope
    const resShared = controller.update({ rawStorageScope: "shared" });
    await Promise.resolve();
    await Promise.resolve();

    expect(resShared.isValid).toBe(false);
    expect(resShared.errorMessage).toContain("não é suportado no runtime Windows");

    // Previous valid registration MUST be cleaned up with unregister
    expect(portalUnregisterSpy).toHaveBeenCalledTimes(1);
    expect(portalUnregisterSpy).toHaveBeenCalledWith("portal-ctrl-scope-1");
  });

  test("changing scope invalid -> valid registers native portal once", async () => {
    const controller = new PortalLifecycleController({
      portalId: "portal-ctrl-scope-2",
      portalName: "Portal Scope 2",
      initialUrl: "https://example.com",
      rawStorageScope: "invalid_scope",
      isNative: true,
      bridge: desktopBridge,
    });

    const resInvalid = controller.mount();
    expect(resInvalid.isValid).toBe(false);
    expect(portalRegisterSpy).toHaveBeenCalledTimes(0);

    // Transition to valid "isolated" scope
    const resValid = controller.update({ rawStorageScope: "isolated" });
    await Promise.resolve();
    await Promise.resolve();

    expect(resValid.isValid).toBe(true);
    expect(portalRegisterSpy).toHaveBeenCalledTimes(1);
    expect(portalRegisterSpy).toHaveBeenCalledWith(
      "portal-ctrl-scope-2",
      "Portal Scope 2",
      "https://example.com",
      "isolated",
    );
  });

  test("portalRegister promise rejection reverses isRegistered flag and notifies error callback", async () => {
    portalRegisterSpy.mockRejectedValueOnce(new Error("IPC Registration Failed"));

    let reportedError: boolean | null = null;
    let reportedMessage: string | null = null;

    const controller = new PortalLifecycleController({
      portalId: "portal-reject-1",
      portalName: "Portal Reject",
      initialUrl: "https://example.com",
      rawStorageScope: "isolated",
      isNative: true,
      bridge: desktopBridge,
      onErrorChange: (err, msg) => {
        reportedError = err;
        reportedMessage = msg;
      },
    });

    controller.mount();

    // Allow rejected promise microtasks to process
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.isCurrentlyRegistered()).toBe(false);
    expect(controller.getLastError()).toBe("IPC Registration Failed");
    expect(reportedError).toBe(true);
    expect(reportedMessage).toBe("IPC Registration Failed");
  });

  test("unmount before portalRegister resolves unregisters cleanly after resolution", async () => {
    let resolveRegistration!: (val: unknown) => void;
    const pendingPromise = new Promise((resolve) => {
      resolveRegistration = resolve;
    });

    portalRegisterSpy.mockReturnValueOnce(pendingPromise);

    const controller = new PortalLifecycleController({
      portalId: "portal-unmount-pending",
      portalName: "Portal Pending",
      initialUrl: "https://example.com",
      rawStorageScope: "isolated",
      isNative: true,
      bridge: desktopBridge,
    });

    controller.mount();
    expect(portalRegisterSpy).toHaveBeenCalledTimes(1);

    // Unmount while registration is still pending
    controller.unmount();
    expect(portalUnregisterSpy).toHaveBeenCalledTimes(0);

    // Now resolve registration promise
    resolveRegistration({ id: "portal-unmount-pending" });
    await Promise.resolve();
    await Promise.resolve();

    expect(portalUnregisterSpy).toHaveBeenCalledWith("portal-unmount-pending");
  });

  test("unmount after portalRegister rejection handles cleanup gracefully without throwing", async () => {
    portalRegisterSpy.mockRejectedValueOnce(new Error("IPC Fail"));

    const controller = new PortalLifecycleController({
      portalId: "portal-unmount-rejected",
      portalName: "Portal Rejected",
      initialUrl: "https://example.com",
      rawStorageScope: "isolated",
      isNative: true,
      bridge: desktopBridge,
    });

    controller.mount();
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.isCurrentlyRegistered()).toBe(false);

    // Unmounting after rejection should not throw and should clean up gracefully
    expect(() => controller.unmount()).not.toThrow();
  });
});
