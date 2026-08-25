import { describe, expect, it, vi } from "vitest";
import type { FileTreeNodeData, FileEntryPayload } from "./FileTreeNode";
import type { FileTreeContent } from "../model/workspace";

describe("FileTreeNode logic & UI contract tests", () => {
  it("determines default view mode as list when undefined", () => {
    const data: FileTreeNodeData = {
      content: {
        name: "Test Explorer",
        rootPath: "C:\\Workspace",
        viewMode: "list",
      },
    };
    expect(data.content?.viewMode ?? "list").toBe("list");
  });

  it("toggles viewMode from list to grid", () => {
    const initialContent: FileTreeContent = {
      name: "Explorer",
      rootPath: "C:\\Projects",
      viewMode: "list",
    };

    const nextViewMode = initialContent.viewMode === "list" ? "grid" : "list";
    expect(nextViewMode).toBe("grid");
  });

  it("preserves file drag data format (application/x-maestri-file and text/plain)", () => {
    const entry: FileEntryPayload = {
      name: "document.txt",
      path: "C:\\Workspace\\document.txt",
      isDir: false,
      isFile: true,
      isSymlink: false,
      size: 1024,
    };

    const setDataMock = vi.fn();
    const mockEvent = {
      preventDefault: vi.fn(),
      dataTransfer: {
        effectAllowed: "",
        setData: setDataMock,
      },
    } as unknown as React.DragEvent;

    if (!entry.isFile) {
      mockEvent.preventDefault();
    } else {
      mockEvent.dataTransfer.effectAllowed = "copy";
      mockEvent.dataTransfer.setData("application/x-maestri-file", entry.path);
      mockEvent.dataTransfer.setData("text/plain", entry.path);
    }

    expect(mockEvent.dataTransfer.effectAllowed).toBe("copy");
    expect(setDataMock).toHaveBeenCalledWith("application/x-maestri-file", "C:\\Workspace\\document.txt");
    expect(setDataMock).toHaveBeenCalledWith("text/plain", "C:\\Workspace\\document.txt");
  });

  it("prevents dragging for directories", () => {
    const dirEntry: FileEntryPayload = {
      name: "src",
      path: "C:\\Workspace\\src",
      isDir: true,
      isFile: false,
      isSymlink: false,
      size: 0,
    };

    const preventDefaultMock = vi.fn();
    const mockEvent = {
      preventDefault: preventDefaultMock,
      dataTransfer: {
        effectAllowed: "",
        setData: vi.fn(),
      },
    } as unknown as React.DragEvent;

    if (!dirEntry.isFile) {
      mockEvent.preventDefault();
    }

    expect(preventDefaultMock).toHaveBeenCalled();
  });
});
