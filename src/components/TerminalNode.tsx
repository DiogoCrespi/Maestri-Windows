import React, { useEffect, useRef, useState } from "react";
import { Handle, Position, NodeProps, NodeResizer } from "@xyflow/react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { desktopBridge } from "../lib/desktopBridge";
import { readClipboardText, writeClipboardText } from "../lib/clipboard";
import { loadScrollback, recordWebScrollback } from "../lib/scrollbackBridge";
import { TerminalContent } from "../model/workspace";
import { applyScrollbackMetadata } from "./terminalContract";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { LocationBadge } from "./LocationBadge";
import { useWorkspaceStore } from "../store/workspaceStore";

export interface TerminalNodeData {
  content: TerminalContent;
  jumpNumber?: number;
  locationType?: string;
  onClose?: () => void;
  onChangeContent?: (content: TerminalContent) => void;
  [key: string]: unknown;
}

export const TerminalNode: React.FC<NodeProps> = ({ id, selected, data }) => {
  const nodeData = data as unknown as TerminalNodeData;
  const content = nodeData?.content;
  const jumpNumber = nodeData?.jumpNumber;
  const ptyId = content?.id || id;

  const currentWorkspaceLocationType = useWorkspaceStore(
    (state) => state.currentDocument?.payload.locationType,
  );
  const locationType = nodeData?.locationType ?? currentWorkspaceLocationType ?? "local";

  const terminalRef = useRef<HTMLDivElement | null>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [isScrollLocked, setIsScrollLocked] = useState(content?.autoScrollLocked ?? false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!terminalRef.current) return;

    // Clean up container children if StrictMode double-mounts
    while (terminalRef.current.firstChild) {
      terminalRef.current.removeChild(terminalRef.current.firstChild);
    }

    const term = new Terminal({
      cursorBlink: true,
      theme: {
        background: "#18181b",
        foreground: "#f4f4f5",
        cursor: "#a1a1aa",
        selectionBackground: "rgba(255, 255, 255, 0.2)",
      },
      fontSize: 13,
      fontFamily: 'Consolas, Monaco, "Courier New", monospace',
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalRef.current);
    fitAddon.fit();

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    const configuredCwd = content?.workingDirectory;
    const windowsCwd =
      configuredCwd && (/^[a-zA-Z]:[\\/]/.test(configuredCwd) || configuredCwd.startsWith("\\\\"))
        ? configuredCwd
        : undefined;
    const configuredShellPath = content?.shellPath?.trim();
    const shellPath = configuredShellPath || undefined;
    let disposed = false;
    let ready = false;
    const pendingInput: string[] = [];

    const unsubscribeData = desktopBridge.onPtyData?.(ptyId, (receivedData) => {
      term.write(receivedData);
      recordWebScrollback(ptyId, receivedData, {
        scrollbackFile: content?.scrollbackFile ?? null,
      });
    });

    const onDataDisposable = term.onData((inputData) => {
      if (ready) {
        void desktopBridge.writePty?.(ptyId, inputData).catch(() => undefined);
      } else {
        pendingInput.push(inputData);
      }
    });

    const handleResize = () => {
      try {
        fitAddon.fit();
        if (ready) {
          void desktopBridge.resizePty?.(ptyId, term.cols, term.rows).catch(() => undefined);
        }
      } catch {
        // Ignore fit resize errors during rapid DOM transformations
      }
    };

    let resizeTimer: number | undefined;
    let lastWidth = -1;
    let lastHeight = -1;
    const resizeObserver = new ResizeObserver(([entry]) => {
      const width = Math.round(entry.contentRect.width);
      const height = Math.round(entry.contentRect.height);
      if (width === 0 || height === 0) return;
      if (width === lastWidth && height === lastHeight) return;
      lastWidth = width;
      lastHeight = height;
      if (resizeTimer !== undefined) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(handleResize, 50);
    });
    resizeObserver.observe(terminalRef.current);

    const configuredCommand = content?.command?.trim();
    // Older/newly-created CanvasWorkspace nodes can contain the shell path
    // in both fields. shellPath selects the executable; command is only the
    // optional command to run inside that interactive shell.
    const initialCommand = configuredCommand &&
      configuredCommand.localeCompare(configuredShellPath ?? "", undefined, { sensitivity: "accent" }) !== 0
      ? configuredCommand
      : undefined;
    const configuredArgs = content?.args;
    const configuredEnv = content?.env;

    const restoreAndStart = async () => {
      try {
        const restored = await loadScrollback({
          terminalId: ptyId,
          scrollbackFile: content?.scrollbackFile,
          scrollbackLineCount: content?.scrollbackLineCount,
        });
        if (disposed) return;

        if (restored.data) {
          // xterm.write renders history only; it does not emit onData and is
          // therefore never sent back to the PTY as user input.
          term.write(restored.data);
        }
        if (content) {
          nodeData.onChangeContent?.(applyScrollbackMetadata(content, restored));
        }
      } catch {
        // The native command is optional until the backend exposes it.
      }

      if (disposed) return;
      try {
        await desktopBridge.createPty!(
          ptyId,
          term.cols,
          term.rows,
          windowsCwd,
          shellPath,
          configuredArgs,
          configuredEnv,
          initialCommand,
          locationType,
        );
        if (!disposed) {
          ready = true;
          for (const input of pendingInput.splice(0)) {
            void desktopBridge.writePty?.(ptyId, input).catch(() => undefined);
          }
          handleResize();
        }
      } catch (error: unknown) {
        if (!disposed) {
          term.writeln(`\r\n\x1b[31mFalha ao iniciar o terminal: ${String(error)}\x1b[0m`);
        }
      }
    };

    void restoreAndStart();

    return () => {
      disposed = true;
      ready = false;
      if (resizeTimer !== undefined) window.clearTimeout(resizeTimer);
      resizeObserver.disconnect();
      onDataDisposable.dispose();
      unsubscribeData?.();
      void desktopBridge.closePty?.(ptyId).catch(() => undefined);
      term.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, [id, content?.id, content?.shellPath, content?.workingDirectory]);

  // Handle focus when node selection status changes or when body is clicked
  useEffect(() => {
    if (selected && xtermRef.current) {
      xtermRef.current.focus();
    }
  }, [selected]);

  const toggleScrollLock = () => {
    setIsScrollLocked((prev) => !prev);
  };

  const handleBodyClick = (e: React.MouseEvent) => {
    // Stop propagation so canvas doesn't steal focus or drag state when clicking terminal body
    e.stopPropagation();
    if (xtermRef.current) {
      xtermRef.current.focus();
    }
  };

  const handleBodyPointerDown = (e: React.PointerEvent) => {
    // Focus before React Flow handles the bubbling pointer event. This keeps
    // the first keystroke in xterm even when the node was not selected yet.
    e.stopPropagation();
    xtermRef.current?.focus();
  };

  const handleFileDrop = (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const path = event.dataTransfer.getData("application/x-maestri-file")
      || event.dataTransfer.getData("text/plain");
    if (!path) return;
    const quotedPath = `"${path.replace(/"/g, '""')}"`;
    void desktopBridge.writePty?.(ptyId, quotedPath).catch(() => undefined);
    xtermRef.current?.focus();
  };

  const terminalMenuItems: ContextMenuItem[] = [
    {
      label: "Copiar",
      shortcut: "Ctrl+Shift+C",
      disabled: !xtermRef.current?.hasSelection(),
      action: async () => {
        const selection = xtermRef.current?.getSelection() ?? "";
        if (selection) await writeClipboardText(selection);
        xtermRef.current?.focus();
      },
    },
    {
      label: "Colar",
      shortcut: "Ctrl+Shift+V",
      action: async () => {
        const value = await readClipboardText();
        if (value) xtermRef.current?.paste(value);
        xtermRef.current?.focus();
      },
    },
    {
      label: "Selecionar tudo",
      shortcut: "Ctrl+A",
      action: () => {
        xtermRef.current?.selectAll();
        xtermRef.current?.focus();
      },
    },
  ];

  return (
    <div
      className={`terminal-node-container ${selected ? "selected" : ""}`}
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        backgroundColor: "#18181b",
        borderRadius: "8px",
        border: selected ? "2px solid #3b82f6" : "1px solid #27272a",
        overflow: "hidden",
        boxShadow: "0 10px 15px -3px rgba(0, 0, 0, 0.5)",
      }}
    >
      <NodeResizer
        minWidth={250}
        minHeight={150}
        isVisible={selected}
        lineStyle={{ borderColor: "#3b82f6", borderWidth: 1 }}
        handleStyle={{ width: 8, height: 8, backgroundColor: "#3b82f6", borderRadius: 2 }}
      />

      <Handle type="target" position={Position.Top} className="connection-handle" />
      <Handle type="source" position={Position.Bottom} className="connection-handle" />

      {/* Terminal Header - Serves as drag handle for React Flow */}
      <div
        className="terminal-header drag-handle"
        style={{
          height: "36px",
          backgroundColor: "#27272a",
          borderBottom: "1px solid #3f3f46",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 12px",
          userSelect: "none",
          cursor: "grab",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span
            style={{
              width: "10px",
              height: "10px",
              borderRadius: "50%",
              backgroundColor: content?.color || "#3b82f6",
              display: "inline-block",
            }}
          />
          <span style={{ fontWeight: 600, fontSize: "13px", color: "#f4f4f5" }}>
            {content?.name || "Terminal"}
          </span>
          <LocationBadge locationType={locationType} />
          {content?.agentType && (
            <span
              style={{
                fontSize: "11px",
                padding: "2px 6px",
                borderRadius: "4px",
                backgroundColor: "#3f3f46",
                color: "#a1a1aa",
              }}
            >
              {content.agentType}
            </span>
          )}
        </div>

        <div
          className="nowheel nodrag"
          style={{ display: "flex", alignItems: "center", gap: "8px" }}
          onClick={(e) => e.stopPropagation()}
        >
          {jumpNumber !== undefined && (
            <span
              className="jump-badge"
              style={{
                backgroundColor: "#3b82f6",
                color: "#ffffff",
                fontSize: "11px",
                fontWeight: 700,
                width: "18px",
                height: "18px",
                borderRadius: "4px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {jumpNumber}
            </span>
          )}
          <button
            onClick={toggleScrollLock}
            title="Toggle Scroll Lock (Cmd+Shift+B)"
            style={{
              background: "none",
              border: "none",
              color: isScrollLocked ? "#ef4444" : "#71717a",
              cursor: "pointer",
              fontSize: "12px",
              padding: "2px 4px",
            }}
          >
            {isScrollLocked ? "🔒" : "🔓"}
          </button>
          <button
            type="button"
            className="node-close-button"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              nodeData.onClose?.();
            }}
            title="Fechar terminal"
            aria-label="Fechar terminal"
          >
            ×
          </button>
        </div>
      </div>

      {/* Terminal Viewport Body - Excluded from React Flow canvas dragging via nodrag */}
      <div
        ref={terminalRef}
        className="terminal-body nodrag nowheel"
        onPointerDown={handleBodyPointerDown}
        onClick={handleBodyClick}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setContextMenu({ x: event.clientX, y: event.clientY });
        }}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDrop={handleFileDrop}
        style={{
          flex: 1,
          width: "100%",
          height: "calc(100% - 36px)",
          padding: "4px",
          backgroundColor: "#18181b",
          boxSizing: "border-box",
          minHeight: 0,
          overflow: "hidden",
        }}
      />
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={terminalMenuItems}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
};
