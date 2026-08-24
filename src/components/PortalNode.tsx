import React, { useEffect, useRef, useState } from "react";
import { Handle, Position, NodeProps, NodeResizer } from "@xyflow/react";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { Webview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { PortalContent } from "../model/workspace";
import { desktopBridge } from "../lib/desktopBridge";
import "./PortalNode.css";

export interface PortalNodeData {
  content?: Partial<PortalContent>;
  url?: string;
  name?: string;
  onChangeURL?: (newUrl: string) => void;
  onClose?: () => void;
  [key: string]: unknown;
}

function sanitizeUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return "about:blank";
  if (/^https?:\/\//i.test(trimmed) || /^about:blank$/i.test(trimmed)) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

export const PortalNode: React.FC<NodeProps> = ({ id, selected, data }) => {
  const nodeData = data as unknown as PortalNodeData;
  const content = nodeData?.content;

  const initialUrl = (
    content?.currentURL ??
    (typeof content?.source === "object" && content?.source && "url" in content.source
      ? content.source.url._0
      : undefined) ??
    nodeData?.url ??
    "https://example.com"
  ).trim();

  const [inputUrl, setInputUrl] = useState(initialUrl);
  const [activeUrl, setActiveUrl] = useState(() => sanitizeUrl(initialUrl));
  const [history, setHistory] = useState<string[]>([sanitizeUrl(initialUrl)]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [hasError, setHasError] = useState(false);

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const portalBodyRef = useRef<HTMLDivElement | null>(null);
  const nativeWebviewRef = useRef<Webview | null>(null);
  const nativeInitialUrlRef = useRef(sanitizeUrl(initialUrl));
  const lastRequestedUrlRef = useRef(sanitizeUrl(initialUrl));
  const isNative = typeof window !== "undefined" && window.__TAURI_INTERNALS__ !== undefined;
  // The canvas node UUID is the single native identity for this Portal. It is
  // also the access-graph ID and the WebView2 label; content.id is not used for
  // addressing because it is a separate persisted content identifier.
  const portalId = id;
  const portalName = content?.name ?? nodeData?.name ?? "Portal";
  const nativeLabel = `portal:${portalId}`;

  useEffect(() => {
    const sanitized = sanitizeUrl(initialUrl);
    setInputUrl(initialUrl);
    setActiveUrl(sanitized);
    setHistory([sanitized]);
    setHistoryIndex(0);
    setHasError(false);

    // A URL update coming from the canvas may be external to this node. Keep
    // the existing WebView2 and ask the registry to navigate it in place.
    if (isNative && sanitized !== lastRequestedUrlRef.current) {
      lastRequestedUrlRef.current = sanitized;
      void desktopBridge.portalNavigate(portalId, sanitized).catch((error: unknown) => {
        console.error(`Falha ao sincronizar URL do Portal ${portalId}`, error);
        setHasError(true);
      });
    }
  }, [initialUrl, isNative, portalId]);

  // Register before commands can be issued and always pair registration with
  // an unregister. Waiting on the registration promise makes cleanup safe if
  // the node unmounts while the native command is still in flight.
  useEffect(() => {
    if (!isNative) return;
    let cancelled = false;
    const registration = desktopBridge.portalRegister(portalId, portalName, sanitizeUrl(initialUrl));

    void registration
      .then(async () => {
        if (cancelled) return;
        try {
          const inspected = await desktopBridge.portalInspect(portalId);
          if (cancelled || inspected.currentUrl === activeUrl) return;
          setInputUrl(inspected.currentUrl);
          setActiveUrl(inspected.currentUrl);
          setHistory([inspected.currentUrl]);
          setHistoryIndex(0);
        } catch (error) {
          console.error(`Falha ao inspecionar Portal ${portalId}`, error);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          console.error(`Falha ao registrar Portal ${portalId}`, error);
          setHasError(true);
        }
      });

    return () => {
      cancelled = true;
      void registration
        .then(() => desktopBridge.portalUnregister(portalId))
        .catch(() => undefined);
    };
  }, [isNative, portalId]);

  useEffect(() => {
    if (!isNative || !portalBodyRef.current) return;
    let cancelled = false;
    let candidate: Webview | null = null;

    const createNativeWebview = async () => {
      try {
        const previous = await Webview.getByLabel(nativeLabel);
        await previous?.close().catch(() => undefined);
        if (cancelled || !portalBodyRef.current) return;
        const rect = portalBodyRef.current.getBoundingClientRect();
        candidate = new Webview(getCurrentWindow(), nativeLabel, {
          url: nativeInitialUrlRef.current,
          x: Math.max(0, rect.left),
          y: Math.max(0, rect.top),
          width: Math.max(1, rect.width),
          height: Math.max(1, rect.height),
        });
        nativeWebviewRef.current = candidate;
        candidate.once("tauri://created", () => {
          if (!cancelled) setHasError(false);
        });
        candidate.once("tauri://error", (event) => {
          if (!cancelled) {
            console.error("Falha ao criar Portal WebView2", event.payload);
            setHasError(true);
          }
        });
        if (cancelled) await candidate.close().catch(() => undefined);
      } catch (error) {
        if (!cancelled) {
          console.error("Falha ao iniciar Portal WebView2", error);
          setHasError(true);
        }
      }
    };

    void createNativeWebview();
    return () => {
      cancelled = true;
      if (candidate && nativeWebviewRef.current === candidate) {
        nativeWebviewRef.current = null;
        void candidate.close().catch(() => undefined);
      }
    };
  }, [isNative, nativeLabel]);

  useEffect(() => {
    if (!isNative) return;
    let animationFrame = 0;
    let lastBounds = "";
    let visible = true;
    const syncBounds = () => {
      const body = portalBodyRef.current;
      const webview = nativeWebviewRef.current;
      if (body && webview) {
        const rect = body.getBoundingClientRect();
        const inWindow = rect.right > 0 && rect.bottom > 0
          && rect.left < window.innerWidth && rect.top < window.innerHeight
          && rect.width > 1 && rect.height > 1;
        if (inWindow) {
          const left = Math.max(0, rect.left);
          const top = Math.max(0, rect.top);
          const width = Math.max(1, Math.min(rect.right, window.innerWidth) - left);
          const height = Math.max(1, Math.min(rect.bottom, window.innerHeight) - top);
          const bounds = `${Math.round(left)}:${Math.round(top)}:${Math.round(width)}:${Math.round(height)}`;
          if (!visible) {
            visible = true;
            void webview.show().catch(() => undefined);
          }
          if (bounds !== lastBounds) {
            lastBounds = bounds;
            void Promise.all([
              webview.setPosition(new LogicalPosition(left, top)),
              webview.setSize(new LogicalSize(width, height)),
            ]).catch(() => undefined);
          }
        } else if (visible) {
          visible = false;
          void webview.hide().catch(() => undefined);
        }
      }
      animationFrame = window.requestAnimationFrame(syncBounds);
    };
    animationFrame = window.requestAnimationFrame(syncBounds);
    return () => window.cancelAnimationFrame(animationFrame);
  }, [isNative]);

  const navigateTo = (rawUrl: string, isHistoryNav = false) => {
    const sanitized = sanitizeUrl(rawUrl);
    lastRequestedUrlRef.current = sanitized;
    setInputUrl(sanitized);
    setActiveUrl(sanitized);
    setHasError(false);

    if (!isHistoryNav) {
      const newHistory = history.slice(0, historyIndex + 1);
      newHistory.push(sanitized);
      setHistory(newHistory);
      setHistoryIndex(newHistory.length - 1);
    }

    nodeData.onChangeURL?.(sanitized);

    if (isNative && !isHistoryNav) {
      void desktopBridge.portalNavigate(portalId, sanitized).catch((error: unknown) => {
        console.error(`Falha ao navegar Portal ${portalId}`, error);
        setHasError(true);
      });
    }
  };

  const handleUrlSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    navigateTo(inputUrl);
  };

  const commitHistoryNavigation = (nextIndex: number, url: string) => {
    setHistoryIndex(nextIndex);
    navigateTo(url, true);
  };

  const handleBack = () => {
    if (historyIndex <= 0) return;
    const prevIndex = historyIndex - 1;
    const previousUrl = history[prevIndex];
    if (!isNative) {
      commitHistoryNavigation(prevIndex, previousUrl);
      return;
    }
    void desktopBridge.portalGoBack(portalId)
      .then((info) => commitHistoryNavigation(prevIndex, info.currentUrl || previousUrl))
      .catch((error: unknown) => console.error(`Falha ao voltar Portal ${portalId}`, error));
  };

  const handleForward = () => {
    if (historyIndex >= history.length - 1) return;
    const nextIndex = historyIndex + 1;
    const nextUrl = history[nextIndex];
    if (!isNative) {
      commitHistoryNavigation(nextIndex, nextUrl);
      return;
    }
    void desktopBridge.portalGoForward(portalId)
      .then((info) => commitHistoryNavigation(nextIndex, info.currentUrl || nextUrl))
      .catch((error: unknown) => console.error(`Falha ao avançar Portal ${portalId}`, error));
  };

  const handleReload = () => {
    setHasError(false);
    if (isNative) {
      void desktopBridge.portalReload(portalId).catch((error: unknown) => {
        console.error(`Falha ao recarregar Portal ${portalId}`, error);
        setHasError(true);
      });
      return;
    }
    if (iframeRef.current) {
      const current = iframeRef.current.src;
      iframeRef.current.src = "about:blank";
      setTimeout(() => {
        if (iframeRef.current) {
          iframeRef.current.src = current;
        }
      }, 50);
    }
  };

  const canGoBack = historyIndex > 0;
  const canGoForward = historyIndex < history.length - 1;

  return (
    <div className={`portal-node-container ${selected ? "selected" : ""}`}>
      <NodeResizer
        minWidth={280}
        minHeight={180}
        isVisible={selected}
        lineStyle={{ borderColor: "#3b82f6", borderWidth: 1 }}
        handleStyle={{ width: 8, height: 8, backgroundColor: "#3b82f6", borderRadius: 2 }}
      />

      <Handle type="target" position={Position.Top} className="connection-handle" />
      <Handle type="source" position={Position.Bottom} className="connection-handle" />

      {/* Header with drag handle and URL bar */}
      <div className="portal-header drag-handle">
        <button
          type="button"
          className="portal-nav-btn nodrag nowheel"
          onClick={handleBack}
          disabled={!canGoBack}
          title="Voltar"
        >
          ◀
        </button>
        <button
          type="button"
          className="portal-nav-btn nodrag nowheel"
          onClick={handleForward}
          disabled={!canGoForward}
          title="Avançar"
        >
          ▶
        </button>
        <button
          type="button"
          className="portal-nav-btn nodrag nowheel"
          onClick={handleReload}
          title="Recarregar"
        >
          ↺
        </button>

        <form onSubmit={handleUrlSubmit} className="portal-url-form nodrag nowheel">
          <input
            type="text"
            className="portal-url-input"
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            placeholder="https://..."
          />
        </form>
        <button
          type="button"
          className="node-close-button nodrag nowheel"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            nodeData.onClose?.();
          }}
          title="Fechar portal"
          aria-label="Fechar portal"
        >
          ×
        </button>
      </div>

      {/* Body containing web iframe or error display */}
      <div ref={portalBodyRef} className="portal-body nodrag nowheel" onClick={(e) => e.stopPropagation()}>
        {hasError ? (
          <div className="portal-error-container">
            <div className="portal-error-icon">⚠️</div>
            <div className="portal-error-title">Erro ao carregar página</div>
            <div className="portal-error-desc">
              Não foi possível carregar &quot;{activeUrl}&quot;. Verifique o endereço ou conexões de rede.
            </div>
            <button
              type="button"
              className="portal-error-retry-btn"
              onClick={handleReload}
            >
              Tentar novamente
            </button>
          </div>
        ) : isNative ? (
          <div className="portal-native-placeholder" aria-label="Portal WebView2 nativo">
            WebView2 nativo ativo
          </div>
        ) : (
          <iframe
            ref={iframeRef}
            src={activeUrl}
            className="portal-iframe"
            title={content?.name || "Portal Browser"}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            onError={() => setHasError(true)}
          />
        )}
      </div>
    </div>
  );
};

export default PortalNode;
