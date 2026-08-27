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

  it("propagates native SSH rejection instead of masking it", async () => {
    const { desktopBridge } = await import("./desktopBridge");
    mocks.invoke.mockRejectedValueOnce(new Error("REMOTE HOST IDENTIFICATION HAS CHANGED"));
    await expect(desktopBridge.sshConnect(config)).rejects.toThrow("HOST IDENTIFICATION");
  });
});
