import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Node } from "@xyflow/react";
import { desktopBridge } from "../lib/desktopBridge";
import testWorkspaceFixture from "../model/TestWorkspace.json";
import type { TerminalContent } from "../model/workspace";
import { useWorkspaceStore } from "../store/workspaceStore";
import { createPreferencesStore } from "../preferences/preferencesStore";
import { terminalContentFromSettings } from "../components/terminalContract";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

const workspacePath = "C:\\workspaces\\preset-role-e2e-workspace.json";

describe("Preset -> Role -> Terminal Creation & Reopen Web E2E Workflow", () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
    vi.stubGlobal("window", { localStorage: storage });
    useWorkspaceStore.setState({ currentDocument: null, nodes: [], edges: [], isDirty: false });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates custom preset & role in preferences, spawns terminal with assignedRoleId, saves workspace, and reopens with role preserved", async () => {
    const preferencesStore = createPreferencesStore(undefined, storage);

    // Step 1: Create custom Preset in preferences
    const preset = preferencesStore.addPreset({
      name: "Rust Compiler CLI",
      agentType: "genericShell",
      command: "cargo watch",
      args: ["-x", "check"],
      icon: "code",
      color: "#f97316",
    });

    // Step 2: Create custom Role linked to preset
    const role = preferencesStore.addRole({
      name: "Rust Core Engineer",
      description: "Handles Rust backend compilation",
      systemPrompt: "Run cargo check and fix errors",
      allowedActions: ["list", "check", "ask"],
      presetId: preset.id,
    });

    // Step 3: Create Terminal content with preset and role applied
    const terminalContent: TerminalContent = terminalContentFromSettings("term-rust-1", "Rust Terminal", {
      name: "Rust Build Terminal",
      shellPath: "powershell.exe",
      workingDirectory: "C:\\projects\\app",
      isManager: false,
      command: preset.command,
      args: preset.args,
      assignedRoleId: role.id,
      agentType: preset.agentType,
      color: preset.color,
      icon: preset.icon,
    });

    const terminalNode: Node = {
      id: "node-rust-1",
      type: "terminal",
      position: { x: 400, y: 250 },
      style: { width: 480, height: 340 },
      data: { content: terminalContent, contentVariant: "terminal" },
    };

    // Step 4: Add terminal node to workspace store
    const actions = useWorkspaceStore.getState();
    actions.loadWorkspace(structuredClone(testWorkspaceFixture));
    actions.addNode(terminalNode);

    expect(useWorkspaceStore.getState().isDirty).toBe(true);

    // Step 5: Save workspace document
    const savedDoc = useWorkspaceStore.getState().serializeWorkspace();
    await desktopBridge.saveWorkspace(workspacePath, savedDoc);
    useWorkspaceStore.getState().markClean();

    // Step 6: Reset store & reload workspace document from persistence
    useWorkspaceStore.setState({ currentDocument: null, nodes: [], edges: [], isDirty: false });
    const reloadedDoc = await desktopBridge.loadWorkspace(workspacePath);
    useWorkspaceStore.getState().loadWorkspace(reloadedDoc);

    const reloadedNodes = useWorkspaceStore.getState().nodes;
    const reloadedTerminalNode = reloadedNodes.find((n) => n.id === "node-rust-1");

    expect(reloadedTerminalNode).toBeDefined();

    const data = reloadedTerminalNode?.data as { content?: TerminalContent };
    expect(data.content?.command).toBe("cargo watch");
    expect(data.content?.assignedRoleId).toBe(role.id);
    expect(data.content?.agentType).toBe("genericShell");
    expect(data.content?.color).toBe("#f97316");
  });
});
