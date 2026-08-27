import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn().mockResolvedValue(() => undefined),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

const config = {
  host: "build.example.test",
  user: "developer",
  port: 22,
  scriptPath: "~/.local/bin/omaestri",
  tunnelPort: 7433,
  addToPath: true,
};

describe("DesktopBridge Remote SSH contract", () => {
  beforeAll(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { __TAURI_INTERNALS__: {}, localStorage: {} },
    });
  });

  afterAll(() => {
    Reflect.deleteProperty(globalThis, "window");
  });

  it("uses the exact Tauri command names and camelCase config payload", async () => {
    const { desktopBridge } = await import("./desktopBridge");
    const connected = {
      state: "connected" as const,
      host: config.host,
      port: config.port,
      tunnelPort: config.tunnelPort,
      message: null,
    };
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "ssh_probe") return Promise.resolve("C:\\Windows\\System32\\OpenSSH\\ssh.exe");
      if (command === "ssh_connect" || command === "ssh_status") return Promise.resolve(connected);
      if (command === "ssh_disconnect") return Promise.resolve({ ...connected, state: "disconnected" });
      if (command === "terminal_create") return Promise.resolve({ id: "term-1", sessionToken: 123 });
      return Promise.resolve(undefined);
    });

    await expect(desktopBridge.sshProbe()).resolves.toContain("ssh.exe");
    await expect(desktopBridge.sshInstall(config)).resolves.toBeUndefined();
    await expect(desktopBridge.sshConnect(config)).resolves.toEqual(connected);
    await expect(desktopBridge.sshStatus()).resolves.toEqual(connected);
    await desktopBridge.sshDisconnect();

    expect(mocks.invoke).toHaveBeenCalledWith("ssh_install", { config });
    expect(mocks.invoke).toHaveBeenCalledWith("ssh_connect", { config });
    expect(mocks.invoke).toHaveBeenCalledWith("ssh_status");
    expect(mocks.invoke).toHaveBeenCalledWith("ssh_disconnect");
  });

  it("sends locationType in camelCase to terminal_create defaulting to 'local' and supporting 'ssh'", async () => {
    const { desktopBridge } = await import("./desktopBridge");
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "terminal_create") return Promise.resolve({ id: "term-1", sessionToken: 123 });
      return Promise.resolve(undefined);
    });

    // 1. Default local creation
    await desktopBridge.createTerminal("term-local", { cols: 80, rows: 24 });
    expect(mocks.invoke).toHaveBeenLastCalledWith("terminal_create", {
      id: "term-local",
      cols: 80,
      rows: 24,
      cwd: undefined,
      shell: undefined,
      args: undefined,
      env: undefined,
      command: undefined,
      locationType: "local",
    });

    // 2. Explicit SSH creation
    await desktopBridge.createTerminal("term-ssh", { cols: 80, rows: 24, locationType: "ssh" });
    expect(mocks.invoke).toHaveBeenLastCalledWith("terminal_create", {
      id: "term-ssh",
      cols: 80,
      rows: 24,
      cwd: undefined,
      shell: undefined,
      args: undefined,
      env: undefined,
      command: undefined,
      locationType: "ssh",
    });
  });

  it("propagates native SSH rejection instead of masking it or falling back silently", async () => {
    const { desktopBridge } = await import("./desktopBridge");
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "ssh_connect") {
        return Promise.reject(new Error("REMOTE HOST IDENTIFICATION HAS CHANGED"));
      }
      if (command === "terminal_create") {
        return Promise.reject(new Error("Túnel SSH não conectado"));
      }
      return Promise.resolve(undefined);
    });

    await expect(desktopBridge.sshConnect(config)).rejects.toThrow("HOST IDENTIFICATION");
    await expect(
      desktopBridge.createTerminal("term-fail", { locationType: "ssh" }),
    ).rejects.toThrow("Túnel SSH não conectado");
  });
});
