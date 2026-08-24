import React, { useEffect, useRef, useState } from "react";
import { Handle, Position, NodeProps, NodeResizer } from "@xyflow/react";
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import "./FilePreviewNode.css";

export interface FilePreviewNodeData {
  path?: string;
  name?: string;
  isReadOnly?: boolean;
  onChangeContent?: (content: string) => void;
  onClose?: () => void;
  [key: string]: unknown;
}

export type FileSyncStatus = "idle" | "loading" | "pending" | "saving" | "saved" | "error" | "readonly";

const SAVE_DEBOUNCE_MS = 700;

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "json", "js", "ts", "jsx", "tsx", "html", "css",
  "scss", "less", "yaml", "yml", "xml", "toml", "ini", "conf", "sh", "bash",
  "ps1", "bat", "cmd", "rs", "py", "c", "cpp", "h", "hpp", "java", "kt", "go",
  "rb", "php", "sql", "log", "env", "gitignore"
]);

export function isTextFile(filenameOrPath: string): boolean {
  const ext = filenameOrPath.split(".").pop()?.toLowerCase() ?? "";
  return TEXT_EXTENSIONS.has(ext);
}

function statusLabel(status: FileSyncStatus): string {
  switch (status) {
    case "loading":
      return "Carregando…";
    case "pending":
      return "Alterações pendentes";
    case "saving":
      return "Salvando…";
    case "saved":
      return "Salvo";
    case "error":
      return "Erro";
    case "readonly":
      return "Somente leitura";
    case "idle":
      return "";
  }
}

export const FilePreviewNode: React.FC<NodeProps> = ({ selected, data }) => {
  const nodeData = data as unknown as FilePreviewNodeData;
  const filePath = nodeData?.path ?? "";
  const fileName = nodeData?.name ?? filePath.split(/[/\\]/).pop() ?? "File";

  const isText = isTextFile(fileName || filePath);
  const explicitReadOnly = Boolean(nodeData?.isReadOnly);
  const readOnly = !isText || explicitReadOnly;

  const [text, setText] = useState<string>("");
  const [syncStatus, setSyncStatus] = useState<FileSyncStatus>(
    !filePath ? "idle" : readOnly ? "loading" : "loading"
  );
  const [syncError, setSyncError] = useState<string | null>(null);

  const textRef = useRef(text);
  const pathGenRef = useRef(0);
  const editVersionRef = useRef(0);
  const dirtyRef = useRef(false);
  const mountedRef = useRef(true);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  textRef.current = text;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Load file content when filePath changes
  useEffect(() => {
    const generation = ++pathGenRef.current;
    dirtyRef.current = false;
    editVersionRef.current += 1;
    setSyncError(null);
    setText("");

    if (!filePath) {
      setSyncStatus("idle");
      return;
    }

    setSyncStatus("loading");
    let active = true;

    // Use backend note_read command directly
    void (async () => {
      try {
        const content = (await tauriInvoke("note_read", { path: filePath })) as string;
        if (!active || !mountedRef.current || pathGenRef.current !== generation) return;

        dirtyRef.current = false;
        setText(content);
        textRef.current = content;
        setSyncError(null);
        setSyncStatus(readOnly ? "readonly" : "saved");
        nodeData.onChangeContent?.(content);
      } catch (err) {
        if (!active || !mountedRef.current || pathGenRef.current !== generation) return;
        const msg = err instanceof Error ? err.message : String(err);
        setSyncError(msg);
        setSyncStatus("error");
      }
    })();

    return () => {
      active = false;
    };
  }, [filePath, readOnly]);

  // Debounced auto-save effect
  useEffect(() => {
    if (!filePath || readOnly || !dirtyRef.current) return;

    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    const generation = pathGenRef.current;
    const editVersion = editVersionRef.current;
    const contentToSave = textRef.current;
    setSyncStatus("pending");

    saveTimerRef.current = setTimeout(() => {
      setSyncStatus("saving");
      void (async () => {
        try {
          await tauriInvoke("note_save", { path: filePath, content: contentToSave });
          if (
            !mountedRef.current ||
            pathGenRef.current !== generation ||
            editVersion !== editVersionRef.current
          )
            return;
          dirtyRef.current = false;
          setSyncError(null);
          setSyncStatus("saved");
        } catch (err) {
          if (
            !mountedRef.current ||
            pathGenRef.current !== generation ||
            editVersion !== editVersionRef.current
          )
            return;
          const msg = err instanceof Error ? err.message : String(err);
          setSyncError(msg);
          setSyncStatus("error");
        }
      })();
    }, SAVE_DEBOUNCE_MS);

    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [filePath, text, readOnly]);

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    if (readOnly) return;
    const val = e.target.value;
    editVersionRef.current += 1;
    dirtyRef.current = Boolean(filePath);
    textRef.current = val;
    setText(val);
    setSyncError(null);
    if (filePath) setSyncStatus("pending");
    nodeData.onChangeContent?.(val);
  };

  return (
    <div className={`file-preview-node ${selected ? "selected" : ""}`}>
      <NodeResizer
        minWidth={220}
        minHeight={160}
        isVisible={selected}
        lineStyle={{ borderColor: "#3b82f6", borderWidth: 1 }}
        handleStyle={{ width: 8, height: 8, backgroundColor: "#3b82f6", borderRadius: 2 }}
      />

      <Handle type="target" position={Position.Top} className="file-preview-handle" />
      <Handle type="source" position={Position.Bottom} className="file-preview-handle" />

      <div className="file-preview-header drag-handle">
        <span className="file-preview-title" title={filePath}>
          {fileName}
        </span>
        <span
          className={`file-preview-status file-preview-status-${syncStatus}`}
          aria-live="polite"
          title={syncError ?? (filePath ? `Caminho: ${filePath}` : "Nenhum arquivo")}
        >
          {statusLabel(syncStatus)}
        </span>
        <button
          type="button"
          className="node-close-button nodrag nowheel"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            nodeData.onClose?.();
          }}
          title="Fechar arquivo"
          aria-label="Fechar arquivo"
        >
          ×
        </button>
      </div>

      <div className="file-preview-body">
        {syncStatus === "loading" && <div className="file-preview-loading">Carregando arquivo...</div>}

        {syncStatus === "error" && (
          <div className="file-preview-error-box">
            <span>Erro ao carregar arquivo:</span>
            <code>{syncError}</code>
          </div>
        )}

        {syncStatus !== "loading" && syncStatus !== "error" && (
          <textarea
            className="file-preview-textarea nodrag nowheel"
            value={text}
            onChange={handleTextChange}
            readOnly={readOnly}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            placeholder={readOnly ? "Visualização de arquivo somente leitura" : "Edite o conteúdo..."}
            spellCheck={false}
          />
        )}
      </div>
    </div>
  );
};

export default FilePreviewNode;
