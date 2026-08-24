import React, { useEffect, useRef, useState } from "react";
import { Handle, Position, NodeProps, NodeResizer } from "@xyflow/react";
import { StickyNoteContent } from "../model/workspace";
import { noteFiles } from "../lib/noteFiles";
import "./note-node.css";

type NoteContentData = Partial<StickyNoteContent> & {
  title?: string;
  text?: string;
  path?: string | null;
};

export interface NoteNodeData {
  content?: NoteContentData;
  title?: string;
  text?: string;
  fileName?: string | null;
  path?: string | null;
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
  // CanvasWorkspace deliberately injects `path: null` while the workspace
  // has no confirmed disk location. Do not fall back to a relative file name
  // in that case, otherwise a new in-memory note could be written into the
  // application's current working directory.
  const hasExplicitContentPath = Boolean(
    nodeData?.content && Object.prototype.hasOwnProperty.call(nodeData.content, "path"),
  );
  const notePathCandidate = hasExplicitContentPath
    ? nodeData.content?.path
    : nodeData?.path ?? nodeData?.content?.fileName ?? nodeData?.fileName ?? null;
  const notePath = notePathCandidate?.trim() || null;

  const [title, setTitle] = useState(initialTitle);
  const [text, setText] = useState(initialText);
  const [syncStatus, setSyncStatus] = useState<NoteSyncStatus>(notePath ? "loading" : "memory");
  const [syncError, setSyncError] = useState<string | null>(null);

  const textRef = useRef(initialText);
  const titleRef = useRef(initialTitle);
  const onChangeContentRef = useRef(nodeData.onChangeContent);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pathGenerationRef = useRef(0);
  const editVersionRef = useRef(0);
  const dirtyRef = useRef(false);
  const loadingRef = useRef(Boolean(notePath));
  const mountedRef = useRef(true);

  onChangeContentRef.current = nodeData.onChangeContent;
  titleRef.current = title;
  textRef.current = text;

  useEffect(() => setTitle(initialTitle), [initialTitle]);

  useEffect(() => {
    if (notePath) return;
    dirtyRef.current = false;
    textRef.current = initialText;
    setText(initialText);
    setSyncError(null);
    setSyncStatus("memory");
  }, [initialText, notePath]);

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
    setSyncError(null);
    textRef.current = initialText;
    setText(initialText);

    if (!notePath) {
      loadingRef.current = false;
      setSyncStatus("memory");
      return;
    }

    loadingRef.current = true;
    setSyncStatus("loading");
    let active = true;
    void noteFiles.read(notePath).then(
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
        const message = error instanceof Error ? error.message : String(error);
        setSyncError(message);
        setSyncStatus("error");
      },
    );

    return () => {
      active = false;
    };
  }, [notePath]);

  useEffect(() => {
    if (!notePath || loadingRef.current || !dirtyRef.current) return;

    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    const generation = pathGenerationRef.current;
    const editVersion = editVersionRef.current;
    const contentToSave = textRef.current;
    setSyncStatus("pending");

    saveTimerRef.current = setTimeout(() => {
      setSyncStatus("saving");
      void noteFiles.save(notePath, contentToSave).then(
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
  }, [notePath, text]);

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    editVersionRef.current += 1;
    dirtyRef.current = Boolean(notePath);
    textRef.current = val;
    setText(val);
    setSyncError(null);
    if (notePath) setSyncStatus("pending");
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

      <Handle type="target" position={Position.Top} className="note-connection-handle" />
      <Handle type="source" position={Position.Bottom} className="note-connection-handle" />

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
          title={syncError ?? (notePath ? `Arquivo: ${notePath}` : "Nota mantida em memória")}
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
