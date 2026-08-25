import React, { useEffect, useState, useCallback } from "react";
import { NodeProps, NodeResizer } from "@xyflow/react";
import { invoke } from "@tauri-apps/api/core";
import { useWorkspaceStore } from "../store/workspaceStore";
import type { FileTreeContent } from "../model/workspace";
import "./FileTreeNode.css";

export interface FileEntryPayload {
  name: string;
  path: string;
  isDir: boolean;
  isFile: boolean;
  isSymlink: boolean;
  size: number;
  modifiedAtMs?: number;
}

export interface DirectoryListingPayload {
  path: string;
  entries: FileEntryPayload[];
  totalEntries: number;
  isTruncated: boolean;
}

export interface FileTreeNodeData {
  content?: FileTreeContent;
  rootPath?: string;
  title?: string;
  viewMode?: "list" | "grid";
  onFileSelect?: (entry: FileEntryPayload) => void;
  onClose?: () => void;
  [key: string]: unknown;
}

export function toggleViewMode(currentMode: "list" | "grid"): "list" | "grid" {
  return currentMode === "list" ? "grid" : "list";
}

export function toggleShowHidden(currentShowHidden: boolean): boolean {
  return !currentShowHidden;
}

export function prepareFileDragData(
  event: Pick<React.DragEvent, "preventDefault" | "dataTransfer">,
  entry: FileEntryPayload
): boolean {
  if (!entry.isFile) {
    event.preventDefault();
    return false;
  }
  event.dataTransfer.effectAllowed = "copy";
  event.dataTransfer.setData("application/x-maestri-file", entry.path);
  event.dataTransfer.setData("text/plain", entry.path);
  return true;
}

export const FileTreeNode: React.FC<NodeProps> = ({ id, selected, data }) => {
  const nodeData = data as unknown as FileTreeNodeData;
  const initialRootPath =
    nodeData?.rootPath || nodeData?.content?.rootPath || "C:\\";
  const initialTitle =
    nodeData?.title || nodeData?.content?.name || "File Explorer";

  const [currentPath, setCurrentPath] = useState<string>(initialRootPath);
  const [history, setHistory] = useState<string[]>([]);
  const [entries, setEntries] = useState<FileEntryPayload[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedEntryPath, setSelectedEntryPath] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState<boolean>(false);

  const viewMode: "list" | "grid" =
    nodeData?.content?.viewMode === "grid" || nodeData?.viewMode === "grid" ? "grid" : "list";

  useEffect(() => {
    setCurrentPath((current) => current === initialRootPath ? current : initialRootPath);
    setHistory([]);
    setSelectedEntryPath(null);
  }, [initialRootPath]);

  const handleToggleViewMode = () => {
    const nextMode = toggleViewMode(viewMode);
    const store = useWorkspaceStore.getState();
    const updatedNodes = store.nodes.map((node) => {
      if (node.id !== id) return node;
      const currentData = (node.data || {}) as Record<string, unknown>;
      const existingContent = (currentData.content || {}) as Record<string, unknown>;
      return {
        ...node,
        data: {
          ...currentData,
          content: {
            ...existingContent,
            viewMode: nextMode,
          },
        },
      };
    });
    store.setNodes(updatedNodes, { dirty: true });
  };

  const handleToggleShowHidden = () => {
    setShowHidden((prev) => toggleShowHidden(prev));
  };

  const fetchDirectory = useCallback(async (dirPath: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await invoke<DirectoryListingPayload>("list_directory", {
        path: dirPath,
        maxEntries: 500,
        includeHidden: showHidden,
      });
      setEntries(res.entries);
      setCurrentPath(res.path);
    } catch (err) {
      const errorMsg =
        typeof err === "string"
          ? err
          : err instanceof Error
          ? err.message
          : "Failed to list directory";
      setError(errorMsg);
    } finally {
      setIsLoading(false);
    }
  }, [showHidden]);

  useEffect(() => {
    fetchDirectory(currentPath);
  }, [fetchDirectory, currentPath]);

  const handleNavigateToFolder = (folderPath: string) => {
    setHistory((prev) => [...prev, currentPath]);
    setCurrentPath(folderPath);
  };

  const handleGoBack = () => {
    if (history.length === 0) return;
    const prevPath = history[history.length - 1];
    setHistory((prev) => prev.slice(0, prev.length - 1));
    setCurrentPath(prevPath);
  };

  const handleRefresh = () => {
    fetchDirectory(currentPath);
  };

  const handleItemClick = (entry: FileEntryPayload) => {
    setSelectedEntryPath(entry.path);
  };

  const handleItemDoubleClick = (entry: FileEntryPayload) => {
    if (entry.isDir) {
      handleNavigateToFolder(entry.path);
    } else if (entry.isFile) {
      nodeData.onFileSelect?.(entry);
    }
  };

  const handleDragStart = (event: React.DragEvent, entry: FileEntryPayload) => {
    prepareFileDragData(event, entry);
  };

  return (
    <div className={`file-tree-node-container ${selected ? "selected" : ""}`} data-node-id={id}>
      <NodeResizer
        minWidth={220}
        minHeight={200}
        isVisible={selected}
        lineStyle={{ borderColor: "#10b981", borderWidth: 1 }}
        handleStyle={{ width: 8, height: 8, backgroundColor: "#10b981", borderRadius: 2 }}
      />

      {/* Header Bar (Drag Handle) */}
      <div className="file-tree-header drag-handle">
        <div className="header-left">
          <span className="folder-icon">📁</span>
          <span className="file-tree-title">{initialTitle}</span>
        </div>
        <div className="header-actions nodrag">
          <button
            type="button"
            className={`action-btn view-toggle-btn ${viewMode === "grid" ? "active" : ""}`}
            onClick={handleToggleViewMode}
            title={viewMode === "list" ? "Alternar para Grid" : "Alternar para Lista"}
            aria-label={viewMode === "list" ? "Alternar para Grid" : "Alternar para Lista"}
          >
            {viewMode === "list" ? "⊞" : "☰"}
          </button>
          <button
            type="button"
            className={`action-btn hidden-toggle-btn ${showHidden ? "active" : ""}`}
            onClick={handleToggleShowHidden}
            title={showHidden ? "Ocultar arquivos do sistema" : "Mostrar arquivos ocultos"}
            aria-label={showHidden ? "Ocultar arquivos do sistema" : "Mostrar arquivos ocultos"}
          >
            {showHidden ? "👁️" : "🙈"}
          </button>
          <button
            type="button"
            className="action-btn"
            onClick={handleGoBack}
            disabled={history.length === 0}
            title="Go Back"
            aria-label="Voltar pasta"
          >
            ←
          </button>
          <button type="button" className="action-btn" onClick={handleRefresh} title="Refresh" aria-label="Atualizar pasta">
            ↻
          </button>
          <button
            type="button"
            className="node-close-button"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              nodeData.onClose?.();
            }}
            title="Fechar arquivos"
            aria-label="Fechar arquivos"
          >
            ×
          </button>
        </div>
      </div>

      {/* Path Breadcrumb Bar */}
      <div className="file-tree-path-bar nodrag">
        <span className="current-path-text" title={currentPath}>
          {currentPath}
        </span>
      </div>

      {/* Main File View (Scrollable, nodrag, nowheel for canvas stability) */}
      <div className="file-tree-body nodrag nowheel">
        {isLoading && (
          <div className="loading-state">
            <span className="spinner">⏳</span> Loading...
          </div>
        )}

        {error && !isLoading && (
          <div className="error-state">
            <span>⚠️ {error}</span>
            <button className="retry-btn" onClick={handleRefresh}>
              Retry
            </button>
          </div>
        )}

        {!isLoading && !error && entries.length === 0 && (
          <div className="empty-state">Empty directory</div>
        )}

        {!isLoading && !error && entries.length > 0 && (
          viewMode === "grid" ? (
            <div className="file-tree-grid" role="list">
              {entries.map((entry) => (
                <div
                  key={entry.path}
                  role="listitem"
                  className={`file-tree-grid-item ${
                    selectedEntryPath === entry.path ? "item-selected" : ""
                  }`}
                  draggable={entry.isFile}
                  onClick={() => handleItemClick(entry)}
                  onDoubleClick={() => handleItemDoubleClick(entry)}
                  onDragStart={(event) => handleDragStart(event, entry)}
                  title={`${entry.name}${entry.isFile ? ` (${formatBytes(entry.size)})` : ""}`}
                >
                  <span className="grid-item-icon">
                    {entry.isDir ? "📁" : entry.isSymlink ? "🔗" : "📄"}
                  </span>
                  <span className="grid-item-name">{entry.name}</span>
                </div>
              ))}
            </div>
          ) : (
            <ul className="file-tree-list">
              {entries.map((entry) => (
                <li
                  key={entry.path}
                  className={`file-tree-item ${
                    selectedEntryPath === entry.path ? "item-selected" : ""
                  }`}
                  draggable={entry.isFile}
                  onClick={() => handleItemClick(entry)}
                  onDoubleClick={() => handleItemDoubleClick(entry)}
                  onDragStart={(event) => handleDragStart(event, entry)}
                >
                  <span className="item-icon">
                    {entry.isDir ? "📁" : entry.isSymlink ? "🔗" : "📄"}
                  </span>
                  <span className="item-name">{entry.name}</span>
                  {entry.isFile && (
                    <span className="item-size">
                      {formatBytes(entry.size)}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )
        )}
      </div>
    </div>
  );
};

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

export default FileTreeNode;
