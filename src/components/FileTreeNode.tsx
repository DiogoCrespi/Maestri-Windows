import React, { useEffect, useState, useCallback } from "react";
import { NodeProps, NodeResizer } from "@xyflow/react";
import { invoke } from "@tauri-apps/api/core";
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

export interface FileTreeNodeContent {
  name?: string;
  rootPath?: string;
  viewMode?: string;
}

export interface FileTreeNodeData {
  content?: FileTreeNodeContent;
  rootPath?: string;
  title?: string;
  onFileSelect?: (entry: FileEntryPayload) => void;
  onClose?: () => void;
  [key: string]: unknown;
}

export const FileTreeNode: React.FC<NodeProps> = ({ selected, data }) => {
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

  useEffect(() => {
    setCurrentPath((current) => current === initialRootPath ? current : initialRootPath);
    setHistory([]);
    setSelectedEntryPath(null);
  }, [initialRootPath]);

  const fetchDirectory = useCallback(async (dirPath: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await invoke<DirectoryListingPayload>("list_directory", {
        path: dirPath,
        maxEntries: 500,
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
  }, []);

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
    if (!entry.isFile) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData("application/x-maestri-file", entry.path);
    event.dataTransfer.setData("text/plain", entry.path);
  };

  return (
    <div className={`file-tree-node-container ${selected ? "selected" : ""}`}>
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
            className="action-btn"
            onClick={handleGoBack}
            disabled={history.length === 0}
            title="Go Back"
          >
            ←
          </button>
          <button className="action-btn" onClick={handleRefresh} title="Refresh">
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

      {/* Main File List View (Scrollable, nodrag, nowheel for canvas stability) */}
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
