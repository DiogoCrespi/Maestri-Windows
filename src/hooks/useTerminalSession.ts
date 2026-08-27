import { useEffect, useRef, useState, useCallback } from 'react';
import { desktopBridge, type CreateTerminalOptions } from '../lib/desktopBridge';
import {
  loadScrollback,
  recordWebScrollback,
  type ScrollbackMetadata,
} from '../lib/scrollbackBridge';

export interface UseTerminalSessionOptions extends CreateTerminalOptions {
  scrollbackFile?: string | null;
  scrollbackLineCount?: number;
  onOutput?: (data: string) => void;
  onExit?: (exitCode: number | null) => void;
  onScrollbackMetadata?: (metadata: ScrollbackMetadata) => void;
  autoStart?: boolean;
}

export interface UseTerminalSessionReturn {
  isReady: boolean;
  isExited: boolean;
  exitCode: number | null;
  error: Error | null;
  isNative: boolean;
  write: (data: string) => Promise<void>;
  resize: (cols: number, rows: number) => Promise<void>;
  stop: () => Promise<void>;
  restart: () => Promise<void>;
}

export function useTerminalSession(
  terminalId: string | null | undefined,
  options: UseTerminalSessionOptions = {}
): UseTerminalSessionReturn {
  const {
    cols = 80,
    rows = 24,
    cwd,
    shellPath,
    command,
    args,
    env,
    locationType,
    scrollbackFile,
    scrollbackLineCount,
    onOutput,
    onExit,
    onScrollbackMetadata,
    autoStart = true,
  } = options;

  const [isReady, setIsReady] = useState<boolean>(false);
  const [isExited, setIsExited] = useState<boolean>(false);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [error, setError] = useState<Error | null>(null);

  // Store options in refs to prevent unnecessary session restarts when callback references change
  const onOutputRef = useRef(onOutput);
  onOutputRef.current = onOutput;

  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

  const onScrollbackMetadataRef = useRef(onScrollbackMetadata);
  onScrollbackMetadataRef.current = onScrollbackMetadata;

  const optionsRef = useRef({ cols, rows, cwd, shellPath, command, args, env, locationType });
  optionsRef.current = { cols, rows, cwd, shellPath, command, args, env, locationType };

  const scrollbackRef = useRef({ scrollbackFile, scrollbackLineCount });
  scrollbackRef.current = { scrollbackFile, scrollbackLineCount };

  const startSession = useCallback(async () => {
    if (!terminalId) return;

    setIsReady(false);
    setIsExited(false);
    setExitCode(null);
    setError(null);

    try {
      await desktopBridge.createTerminal(terminalId, optionsRef.current);
      setIsReady(true);
    } catch (err) {
      const errorObj = err instanceof Error ? err : new Error(String(err));
      setError(errorObj);
      setIsReady(false);
    }
  }, [terminalId]);

  const stopSession = useCallback(async () => {
    if (!terminalId) return;
    try {
      await desktopBridge.stopTerminal(terminalId);
    } catch (err) {
      console.error(`Failed to stop terminal session ${terminalId}:`, err);
    }
  }, [terminalId]);

  const write = useCallback(
    async (data: string) => {
      if (!terminalId || !isReady || isExited) return;
      try {
        await desktopBridge.writeTerminal(terminalId, data);
      } catch (err) {
        console.error(`Failed to write to terminal session ${terminalId}:`, err);
      }
    },
    [terminalId, isReady, isExited]
  );

  const resize = useCallback(
    async (newCols: number, newRows: number) => {
      if (!terminalId || !isReady || isExited) return;
      try {
        await desktopBridge.resizeTerminal(terminalId, newCols, newRows);
      } catch (err) {
        console.error(`Failed to resize terminal session ${terminalId}:`, err);
      }
    },
    [terminalId, isReady, isExited]
  );

  // Set up listeners and lifecycle
  useEffect(() => {
    if (!terminalId) return;

    let unlistenOutput: (() => void) | null = null;
    let unlistenExited: (() => void) | null = null;
    let isMounted = true;

    const setupListenersAndStart = async () => {
      try {
        unlistenOutput = await desktopBridge.onTerminalOutput((payload) => {
          if (payload.terminalId === terminalId && isMounted) {
            recordWebScrollback(terminalId, payload.data, scrollbackRef.current);
            onOutputRef.current?.(payload.data);
          }
        });

        unlistenExited = await desktopBridge.onTerminalExited((payload) => {
          if (payload.terminalId === terminalId && isMounted) {
            setIsExited(true);
            setExitCode(payload.exitCode);
            onExitRef.current?.(payload.exitCode);
          }
        });

        if (isMounted) {
          try {
            const restored = await loadScrollback({
              terminalId,
              scrollbackFile: scrollbackRef.current.scrollbackFile,
              scrollbackLineCount: scrollbackRef.current.scrollbackLineCount,
            });
            if (restored.data && isMounted) {
              // This calls the render callback only. It never goes through
              // writeTerminal, so restored bytes cannot be re-executed.
              onOutputRef.current?.(restored.data);
            }
            if (isMounted) onScrollbackMetadataRef.current?.(restored);
          } catch {
            // A missing native load command must not prevent the PTY from starting.
          }
        }

        if (autoStart && isMounted) {
          await startSession();
        }
      } catch (err) {
        if (isMounted) {
          setError(err instanceof Error ? err : new Error(String(err)));
        }
      }
    };

    setupListenersAndStart();

    return () => {
      isMounted = false;
      if (unlistenOutput) unlistenOutput();
      if (unlistenExited) unlistenExited();
      stopSession();
    };
  }, [terminalId, autoStart, startSession, stopSession]);

  return {
    isReady,
    isExited,
    exitCode,
    error,
    isNative: desktopBridge.isNative,
    write,
    resize,
    stop: stopSession,
    restart: startSession,
  };
}
