import React, { useEffect, useRef, useState } from "react";
import { Handle, Position, NodeProps, NodeResizer } from "@xyflow/react";
import { StickyNoteContent } from "../model/workspace";
import { noteFiles } from "../lib/noteFiles";
import "./note-node.css";

type NoteContentData = Partial<StickyNoteContent> & {
  title?: string;
  text?: string;
  path?: string | null;
  workspaceRoot?: string | null;
  resourcePath?: string | null;
  isCustom?: boolean;
};

export interface NoteNodeData {
  content?: NoteContentData;
  title?: string;
  text?: string;
  fileName?: string | null;
  path?: string | null;
  workspaceRoot?: string | null;
  resourcePath?: string | null;
  isCustom?: boolean;
  color?: string;
  onChangeContent?: (updatedText: string, updatedTitle?: string) => void;
  onClose?: () => void;
  [key: string]: unknown;
}

type NoteSyncStatus = "memory" | "loading" | "pending" | "saving" | "saved" | "error";

const SAVE_DEBOUNCE_MS = 700;

function statusLabel(status: NoteSyncStatus): string {
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
    case "memory":
      return "Somente memória";
  }
}

export const NoteNode: React.FC<NodeProps> = ({ selected, data }) => {
  const nodeData = data as unknown as NoteNodeData;
  const initialTitle = nodeData?.title ?? nodeData?.content?.title ?? "Sticky Note";
  const initialText = nodeData?.text ?? nodeData?.content?.text ?? "";
  const noteColor = nodeData?.color ?? nodeData?.content?.color ?? "#fef08a";

  const workspaceRoot = nodeData?.workspaceRoot ?? nodeData?.content?.workspaceRoot ?? null;
  const resourcePathCandidate = nodeData?.resourcePath ?? nodeData?.content?.resourcePath ?? nodeData?.content?.fileName ?? nodeData?.fileName ?? null;
  const resourcePath = resourcePathCandidate?.trim() || null;
  const isCustom = Boolean(nodeData?.isCustom ?? nodeData?.content?.isCustom);

  const [title, setTitle] = useState(initialTitle);
  const [text, setText] = useState(initialText);
  const [syncStatus, setSyncStatus] = useState<NoteSyncStatus>(
    isCustom ? "error" : workspaceRoot && resourcePath ? "loading" : "memory",
  );
  const [syncError, setSyncError] = useState<string | null>(
    isCustom ? "Notas customizadas com caminhos absolutos estão desabilitadas por segurança." : null,
  );

  const textRef = useRef(initialText);
  const titleRef = useRef(initialTitle);
  const onChangeContentRef = useRef(nodeData.onChangeContent);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pathGenerationRef = useRef(0);
  const editVersionRef = useRef(0);
  const dirtyRef = useRef(false);
  const loadingRef = useRef(Boolean(!isCustom && workspaceRoot && resourcePath));
  const mountedRef = useRef(true);

  onChangeContentRef.current = nodeData.onChangeContent;
  titleRef.current = title;
  textRef.current = text;

  useEffect(() => setTitle(initialTitle), [initialTitle]);

  useEffect(() => {
    if (workspaceRoot && resourcePath && !isCustom) return;
    dirtyRef.current = false;
    textRef.current = initialText;
    setText(initialText);
    if (isCustom) {
      setSyncError("Notas customizadas com caminhos absolutos estão desabilitadas por segurança.");
      setSyncStatus("error");
    } else {
      setSyncError(null);
      setSyncStatus("memory");
    }
  }, [initialText, workspaceRoot, resourcePath, isCustom]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const generation = pathGenerationRef.current + 1;
    pathGenerationRef.current = generation;
    dirtyRef.current = false;
    editVersionRef.current += 1;
    textRef.current = initialText;
    setText(initialText);

    if (isCustom) {
      loadingRef.current = false;
      setSyncError("Notas customizadas com caminhos absolutos estão desabilitadas por segurança.");
      setSyncStatus("error");
      return;
    }

    if (!workspaceRoot || !resourcePath) {
      loadingRef.current = false;
      setSyncError(null);
      setSyncStatus("memory");
      return;
    }

    loadingRef.current = true;
    setSyncStatus("loading");
    setSyncError(null);
    let active = true;

    void noteFiles.readScoped(workspaceRoot, resourcePath).then(
      (content) => {
        if (!active || !mountedRef.current || pathGenerationRef.current !== generation) return;
        loadingRef.current = false;
        dirtyRef.current = false;
        textRef.current = content;
        setText(content);
        setSyncError(null);
        setSyncStatus("saved");
        onChangeContentRef.current?.(content, titleRef.current);
      },
      (error: unknown) => {
        if (!active || !mountedRef.current || pathGenerationRef.current !== generation) return;
        loadingRef.current = false;
        const msg = error instanceof Error ? error.message : String(error);
        const isNotFound =
          (typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "not_found") ||
          msg.includes("not found") ||
          msg.includes("does not exist") ||
          msg.includes("cannot canonicalize workspace root") ||
          msg.includes("cannot canonicalize note directory") ||
          msg.includes("Failed to read note");

        if (isNotFound) {
          // Se a pasta ou o arquivo da nota ainda nao existem no disco, trata como nota nova
          dirtyRef.current = false;
          setSyncError(null);
          setSyncStatus("saved");
          return;
        }
        setSyncError(msg);
        setSyncStatus("error");
      },
    );

    return () => {
      active = false;
    };
  }, [workspaceRoot, resourcePath, isCustom]);

  useEffect(() => {
    if (isCustom || !workspaceRoot || !resourcePath || loadingRef.current || !dirtyRef.current) return;

    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    const generation = pathGenerationRef.current;
    const editVersion = editVersionRef.current;
    const contentToSave = textRef.current;
    setSyncStatus("pending");

    saveTimerRef.current = setTimeout(() => {
      setSyncStatus("saving");
      void noteFiles.saveScoped(workspaceRoot, resourcePath, contentToSave).then(
        () => {
          if (
            !mountedRef.current ||
            pathGenerationRef.current !== generation ||
            editVersion !== editVersionRef.current
          ) return;
          dirtyRef.current = false;
          setSyncError(null);
          setSyncStatus("saved");
        },
        (error: unknown) => {
          if (
            !mountedRef.current ||
            pathGenerationRef.current !== generation ||
            editVersion !== editVersionRef.current
          ) return;
          const message = error instanceof Error ? error.message : String(error);
          setSyncError(message);
          setSyncStatus("error");
        },
      );
    }, SAVE_DEBOUNCE_MS);

    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [workspaceRoot, resourcePath, isCustom, text]);

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    editVersionRef.current += 1;
    dirtyRef.current = Boolean(!isCustom && workspaceRoot && resourcePath);
    textRef.current = val;
    setText(val);
    if (isCustom) {
      setSyncStatus("error");
    } else if (workspaceRoot && resourcePath) {
      setSyncError(null);
      setSyncStatus("pending");
    }
    nodeData.onChangeContent?.(val, title);
  };

  const handleTitleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    titleRef.current = val;
    setTitle(val);
    nodeData.onChangeContent?.(text, val);
  };

  return (
    <div
      className={`note-node-container ${selected ? "selected" : ""}`}
      style={{ backgroundColor: noteColor }}
    >
      <NodeResizer
        minWidth={180}
        minHeight={140}
        isVisible={selected}
        lineStyle={{ borderColor: "#ca8a04", borderWidth: 1 }}
        handleStyle={{ width: 8, height: 8, backgroundColor: "#ca8a04", borderRadius: 2 }}
      />

      {/* Border connection handles on all 4 sides (invisible & expanded) */}
      <Handle type="target" position={Position.Top} id="top-target" className="edge-handle edge-handle-top" />
      <Handle type="source" position={Position.Top} id="top-source" className="edge-handle edge-handle-top" />
      <Handle type="target" position={Position.Right} id="right-target" className="edge-handle edge-handle-right" />
      <Handle type="source" position={Position.Right} id="right-source" className="edge-handle edge-handle-right" />
      <Handle type="target" position={Position.Bottom} id="bottom-target" className="edge-handle edge-handle-bottom" />
      <Handle type="source" position={Position.Bottom} id="bottom-source" className="edge-handle edge-handle-bottom" />
      <Handle type="target" position={Position.Left} id="left-target" className="edge-handle edge-handle-left" />
      <Handle type="source" position={Position.Left} id="left-source" className="edge-handle edge-handle-left" />

      {/* Note Header / Title Bar (Drag Handle) */}
      <div className="note-header drag-handle">
        <input
          type="text"
          className="note-title-input nodrag nowheel"
          value={title}
          onChange={handleTitleChange}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          placeholder="Note title..."
        />
        <span
          className={`note-save-status note-save-status-${syncStatus}`}
          aria-live="polite"
          title={syncError ?? (workspaceRoot && resourcePath ? `Recurso: notes/${resourcePath}` : "Nota mantida em memória")}
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
          title="Fechar nota"
          aria-label="Fechar nota"
        >
          ×
        </button>
      </div>

      {/* Note Body (Raw Markdown Editor Area) */}
      <div className="note-body">
        <textarea
          className="note-textarea nodrag nowheel"
          value={text}
          onChange={handleTextChange}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          placeholder="Type markdown content..."
          spellCheck={false}
        />
      </div>
    </div>
  );
};

export default NoteNode;
