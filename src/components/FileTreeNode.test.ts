import { describe, expect, it, vi } from "vitest";
import {
  toggleViewMode,
  toggleShowHidden,
  prepareFileDragData,
  FileEntryPayload,
} from "./FileTreeNode";
import { useWorkspaceStore } from "../store/workspaceStore";

describe("FileTreeNode helpers and workspace store integration", () => {
  it("toggleViewMode correctly toggles between list and grid", () => {
    expect(toggleViewMode("list")).toBe("grid");
    expect(toggleViewMode("grid")).toBe("list");
  });

  it("toggleShowHidden correctly toggles boolean state", () => {
    expect(toggleShowHidden(false)).toBe(true);
    expect(toggleShowHidden(true)).toBe(false);
  });

  it("prepareFileDragData sets payload for files and returns true", () => {
    const entry: FileEntryPayload = {
      name: "report.pdf",
      path: "C:\\Docs\\report.pdf",
      isDir: false,
      isFile: true,
      isSymlink: false,
      size: 2048,
    };
    const setData = vi.fn();
    const preventDefault = vi.fn();
    const mockEvent = { setData, preventDefault, dataTransfer: { effectAllowed: "", setData } } as unknown as React.DragEvent;

    const result = prepareFileDragData(mockEvent, entry);

    expect(result).toBe(true);
    expect(mockEvent.dataTransfer.effectAllowed).toBe("copy");
    expect(setData).toHaveBeenCalledWith("application/x-maestri-file", "C:\\Docs\\report.pdf");
    expect(setData).toHaveBeenCalledWith("text/plain", "C:\\Docs\\report.pdf");
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("prepareFileDragData prevents default for directories and returns false", () => {
    const entry: FileEntryPayload = {
      name: "src",
      path: "C:\\Projects\\src",
      isDir: true,
      isFile: false,
      isSymlink: false,
      size: 0,
    };
    const setData = vi.fn();
    const preventDefault = vi.fn();
    const mockEvent = { setData, preventDefault } as unknown as React.DragEvent;

    const result = prepareFileDragData(mockEvent, entry);

    expect(result).toBe(false);
    expect(preventDefault).toHaveBeenCalled();
    expect(setData).not.toHaveBeenCalled();
  });

  it("updates viewMode in workspace store and marks store as dirty when toggled", () => {
    const store = useWorkspaceStore.getState();
    const initialNode = {
      id: "filetree-node-1",
      type: "fileTree",
      position: { x: 100, y: 100 },
      data: {
        contentVariant: "fileTree",
        content: {
          name: "File Explorer",
          rootPath: "C:\\Repo",
          viewMode: "list",
        },
      },
    };

    store.setNodes([initialNode], { dirty: false });
    store.markClean();
    expect(useWorkspaceStore.getState().isDirty).toBe(false);

    // Simula a ação do handleToggleViewMode
    const nextMode = toggleViewMode("list");
    const currentNodes = useWorkspaceStore.getState().nodes;
    const updatedNodes = currentNodes.map((n) => {
      if (n.id !== "filetree-node-1") return n;
      const data = (n.data || {}) as Record<string, unknown>;
      const content = (data.content || {}) as Record<string, unknown>;
      return {
        ...n,
        data: {
          ...data,
          content: {
            ...content,
            viewMode: nextMode,
          },
        },
      };
    });

    useWorkspaceStore.getState().setNodes(updatedNodes, { dirty: true });

    const stateAfterUpdate = useWorkspaceStore.getState();
    expect(stateAfterUpdate.isDirty).toBe(true);
    const updatedNode = stateAfterUpdate.nodes.find((n) => n.id === "filetree-node-1");
    expect((updatedNode?.data.content as Record<string, unknown>).viewMode).toBe("grid");
  });
});
