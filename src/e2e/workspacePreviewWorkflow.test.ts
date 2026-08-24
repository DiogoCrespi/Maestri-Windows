import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Node } from "@xyflow/react";
import { desktopBridge } from "../lib/desktopBridge";
import testWorkspaceFixture from "../model/TestWorkspace.json";
import type { FileTreeContent, StickyNoteContent, TerminalContent } from "../model/workspace";
import { useWorkspaceStore } from "../store/workspaceStore";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

const workspacePath = "C:\\workspaces\\e2e-workspace.json";

function terminalNode(): Node {
  const content: TerminalContent = {
    id: "terminal-e2e",
    agentType: "shell",
    command: "powershell.exe",
    name: "Terminal E2E",
    icon: "terminal",
    color: "#3b82f6",
    shellPath: "powershell.exe",
    workingDirectory: "C:\\workspaces",
    status: "idle",
    isManager: false,
    monitorWithOmbro: false,
    autoScrollLocked: false,
    shortcutMode: { kind: "automatic" },
    scrollbackLineCount: 0,
  };
  return {
    id: "terminal-node-e2e",
    type: "terminal",
    position: { x: 300, y: 180 },
    style: { width: 450, height: 320 },
    data: { content, contentVariant: "terminal" },
  };
}

function noteNode(): Node {
  const content: StickyNoteContent & { title: string; text: string } = {
    title: "Plano E2E",
    text: "- terminal\n- canvas\n- persistência",
    fileName: "Note-e2e.md",
    color: "#fef08a",
    fontSize: 14,
    hasCustomName: true,
    isPreviewing: false,
    storageMode: { managed: {} },
  };
  return {
    id: "note-node-e2e",
    type: "stickyNote",
    position: { x: 810, y: 220 },
    style: { width: 260, height: 220 },
    data: { content, contentVariant: "stickyNote" },
  };
}

function fileTreeNode(): Node {
  const content: FileTreeContent = {
    name: "Arquivos E2E",
    rootPath: "C:\\workspaces",
    viewMode: "tree",
  };
  return {
    id: "file-tree-node-e2e",
    type: "fileTree",
    position: { x: 1120, y: 120 },
    style: { width: 340, height: 420 },
    data: { content, contentVariant: "fileTree" },
  };
}

describe("workspace preview lightweight E2E", () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
    vi.stubGlobal("window", { localStorage: storage });
    useWorkspaceStore.setState({ currentDocument: null, nodes: [], edges: [], isDirty: false });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates every MVP node, moves the canvas, saves and reopens in web preview", async () => {
    const actions = useWorkspaceStore.getState();
    actions.loadWorkspace(structuredClone(testWorkspaceFixture));
    actions.addNode(terminalNode());
    actions.addNode(noteNode());
    actions.addNode(fileTreeNode());
    actions.updateNodePosition("terminal-node-e2e", { x: 640, y: 360 });
    actions.updateNodeDimensions("file-tree-node-e2e", 390, 480);
    actions.updateViewport({ x: -425, y: 215 }, 1.4);

    expect(useWorkspaceStore.getState().isDirty).toBe(true);
    const saved = useWorkspaceStore.getState().serializeWorkspace();
    await desktopBridge.saveWorkspace(workspacePath, saved);
    useWorkspaceStore.getState().markClean();

    expect(storage.getItem(`maestri-workspace:${workspacePath}`)).not.toBeNull();
    expect(useWorkspaceStore.getState().isDirty).toBe(false);

    useWorkspaceStore.setState({ currentDocument: null, nodes: [], edges: [], isDirty: false });
    const reopened = await desktopBridge.loadWorkspace(workspacePath);
    useWorkspaceStore.getState().loadWorkspace(reopened);

    const state = useWorkspaceStore.getState();
    expect(state.nodes.map((node) => node.type)).toEqual(expect.arrayContaining([
      "terminal", "stickyNote", "fileTree",
    ]));
    expect(state.nodes.find((node) => node.id === "terminal-node-e2e")?.position).toEqual({ x: 640, y: 360 });
    expect(state.nodes.find((node) => node.id === "file-tree-node-e2e")?.style).toMatchObject({ width: 390, height: 480 });
    expect(state.currentDocument?.payload.canvasOrigin).toEqual({ x: -425, y: 215 });
    expect(state.currentDocument?.payload.canvasZoom).toBe(1.4);
    expect(state.isDirty).toBe(false);

    const roundtrip = state.serializeWorkspace();
    expect(roundtrip.payload.nodes.find((node) => node.id === "terminal-node-e2e")?.content).toMatchObject({
      terminal: { _0: { shellPath: "powershell.exe" } },
    });
    expect(roundtrip.payload.nodes.find((node) => node.id === "note-node-e2e")?.content).toMatchObject({
      stickyNote: { _0: { title: "Plano E2E", fileName: "Note-e2e.md" } },
    });
    expect(roundtrip.payload.nodes.find((node) => node.id === "file-tree-node-e2e")?.content).toMatchObject({
      fileTree: { _0: { rootPath: "C:\\workspaces", viewMode: "tree" } },
    });
  });

  it("reports a missing workspace instead of silently creating one", async () => {
    await expect(desktopBridge.loadWorkspace("missing.json")).rejects.toThrow(
      "Workspace não encontrado no preview web",
    );
  });
});
