import React, { useEffect, useMemo, useRef, useState } from "react";
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

export interface StorageScopeValidationResult {
  isValid: boolean;
  scope: string;
  errorMessage?: string;
  webviewOptions?: {
    incognito?: boolean;
  };
}

export function validateFrontendStorageScope(rawScope: string): StorageScopeValidationResult {
  const trimmed = (rawScope || "").trim();
  if (!trimmed || trimmed === "isolated") {
    return {
      isValid: true,
      scope: "isolated",
      webviewOptions: { incognito: true },
    };
  }
  if (trimmed === "shared") {
    return {
      isValid: false,
      scope: "shared",
      errorMessage: `Escopo de armazenamento 'shared' não é suportado no runtime Windows sem integração de edges portal-a-portal (lacuna documentada)`,
    };
  }
  return {
    isValid: false,
    scope: trimmed,
    errorMessage: `Escopo de armazenamento não suportado: "${trimmed}"`,
  };
}

export function sanitizeUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return "about:blank";
  if (/^https?:\/\//i.test(trimmed) || /^about:blank$/i.test(trimmed)) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

export interface PortalLifecycleParams {
  portalId: string;
  portalName: string;
  initialUrl: string;
  rawStorageScope: string;
  isNative: boolean;
  bridge?: typeof desktopBridge;
  onErrorChange?: (hasError: boolean, errorMessage: string | null) => void;
}

export class PortalLifecycleController {
  private portalId: string;
  private portalName: string;
  private initialUrl: string;
  private rawStorageScope: string;
  private isNative: boolean;
  private bridge: typeof desktopBridge;
  private onErrorChange?: (hasError: boolean, errorMessage: string | null) => void;

  private isRegistered = false;
  private currentRegisteredId: string | null = null;
  private currentScope: string | null = null;
  private registrationPromise: Promise<unknown> | null = null;
  private lastError: string | null = null;

  constructor(params: PortalLifecycleParams) {
    this.portalId = params.portalId;
    this.portalName = params.portalName;
    this.initialUrl = sanitizeUrl(params.initialUrl);
    this.rawStorageScope = params.rawStorageScope;
    this.isNative = params.isNative;
    this.bridge = params.bridge ?? desktopBridge;
    this.onErrorChange = params.onErrorChange;
  }

  public getValidation(): StorageScopeValidationResult {
    return validateFrontendStorageScope(this.rawStorageScope);
  }

  public getLastError(): string | null {
    return this.lastError;
  }

  public isCurrentlyRegistered(): boolean {
    return this.isRegistered;
  }

  public mount(): StorageScopeValidationResult {
    const validation = this.getValidation();
    if (!this.isNative) {
      this.cleanupRegistration();
      this.lastError = null;
      return validation;
    }

    if (!validation.isValid) {
      this.cleanupRegistration();
      this.lastError = validation.errorMessage ?? "Escopo inválido";
      this.onErrorChange?.(true, this.lastError);
      return validation;
    }

    if (
      !this.isRegistered ||
      this.currentRegisteredId !== this.portalId ||
      this.currentScope !== validation.scope
    ) {
      this.cleanupRegistration();
      this.isRegistered = true;
      this.currentRegisteredId = this.portalId;
      this.currentScope = validation.scope;
      this.lastError = null;

      const pid = this.portalId;
      const reg = this.bridge.portalRegister(
        pid,
        this.portalName,
        this.initialUrl,
        validation.scope,
      );

      this.registrationPromise = reg;

      void reg
        .then(async () => {
          if (this.isRegistered && this.currentRegisteredId === pid) {
            try {
              await this.bridge.portalInspect(pid);
            } catch {
              // ignore inspect error
            }
          }
        })
        .catch((error: unknown) => {
          if (this.currentRegisteredId === pid) {
            this.isRegistered = false;
            this.currentRegisteredId = null;
            this.currentScope = null;
            const errMsg = error instanceof Error ? error.message : String(error);
            this.lastError = errMsg;
            this.onErrorChange?.(true, errMsg);
          }
        });
    }

    return validation;
  }

  public update(params: Partial<PortalLifecycleParams>): StorageScopeValidationResult {
    const idChanged = params.portalId !== undefined && params.portalId !== this.portalId;

    if (params.portalId !== undefined) this.portalId = params.portalId;
    if (params.portalName !== undefined) this.portalName = params.portalName;
    if (params.rawStorageScope !== undefined) this.rawStorageScope = params.rawStorageScope;
    if (params.isNative !== undefined) this.isNative = params.isNative;
    if (params.onErrorChange !== undefined) this.onErrorChange = params.onErrorChange;

    if (idChanged && this.isRegistered) {
      this.cleanupRegistration();
    }

    return this.mount();
  }

  public unmount(): void {
    this.cleanupRegistration();
  }

  private cleanupRegistration(): void {
    if (this.isRegistered || this.currentRegisteredId !== null) {
      const pidToUnregister = this.currentRegisteredId || this.portalId;
      this.isRegistered = false;
      this.currentRegisteredId = null;
      this.currentScope = null;
      const p = this.registrationPromise;
      this.registrationPromise = null;

      if (p) {
        void p
          .catch(() => undefined)
          .then(() => this.bridge.portalUnregister(pidToUnregister))
          .catch(() => undefined);
      } else {
        void this.bridge.portalUnregister(pidToUnregister).catch(() => undefined);
      }
    }
  }
}

export function usePortalLifecycle({
  portalId,
  portalName,
  initialUrl,
  rawStorageScope,
  isNative,
}: PortalLifecycleParams) {
  const validation = useMemo(() => validateFrontendStorageScope(rawStorageScope), [rawStorageScope]);

  const [hasError, setHasError] = useState(!validation.isValid);
  const [errorMessage, setErrorMessage] = useState<string | null>(validation.errorMessage ?? null);

  const controllerRef = useRef<PortalLifecycleController | null>(null);

  if (!controllerRef.current) {
    controllerRef.current = new PortalLifecycleController({
      portalId,
      portalName,
      initialUrl,
      rawStorageScope,
      isNative,
      onErrorChange: (err, msg) => {
        setHasError(err);
        setErrorMessage(msg);
      },
    });
  }

  const controller = controllerRef.current;

  useEffect(() => {
    const res = controller.update({
      portalId,
      portalName,
      rawStorageScope,
      isNative,
      onErrorChange: (err, msg) => {
        setHasError(err);
        setErrorMessage(msg);
      },
    });

    setHasError(!res.isValid || controller.getLastError() !== null);
    setErrorMessage(res.errorMessage ?? controller.getLastError());

    return () => {
      controller.unmount();
    };
  }, [controller, portalId, validation.scope, validation.isValid, isNative]);

  return {
    controller,
    validation,
    isScopeValid: validation.isValid,
    validatedScope: validation.scope,
    hasError,
    setHasError,
    errorMessage,
    setErrorMessage,
  };
}

export const PortalNode: React.FC<NodeProps> = ({ id, selected, data }) => {
  const nodeData = data as unknown as PortalNodeData;
  const content = nodeData?.content;

  const rawStorageScope = content?.storageScope ?? "isolated";
  const initialUrl = (
    content?.currentURL ??
    (typeof content?.source === "object" && content?.source && "url" in content.source
      ? content.source.url._0
      : undefined) ??
    nodeData?.url ??
    "https://example.com"
  ).trim();

  const isNative = typeof window !== "undefined" && window.__TAURI_INTERNALS__ !== undefined;
  const portalId = id;
  const portalName = content?.name ?? nodeData?.name ?? "Portal";
  const nativeLabel = `portal:${portalId}`;

  const {
    validation,
    isScopeValid,
    validatedScope,
    hasError,
    setHasError,
    errorMessage,
    setErrorMessage,
  } = usePortalLifecycle({
    portalId,
    portalName,
    initialUrl,
    rawStorageScope,
    isNative,
  });

  const incognitoOption = validation.webviewOptions?.incognito;

  const [inputUrl, setInputUrl] = useState(initialUrl);
  const [activeUrl, setActiveUrl] = useState(() => sanitizeUrl(initialUrl));
  const [history, setHistory] = useState<string[]>([sanitizeUrl(initialUrl)]);
  const [historyIndex, setHistoryIndex] = useState(0);

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const portalBodyRef = useRef<HTMLDivElement | null>(null);
  const nativeWebviewRef = useRef<Webview | null>(null);
  const lastRequestedUrlRef = useRef(sanitizeUrl(initialUrl));
  const creationInitialUrlRef = useRef(sanitizeUrl(initialUrl));

  // 1. Synchronize external URL updates coming from canvas props to native webview in-place.
  useEffect(() => {
    const sanitized = sanitizeUrl(initialUrl);
    setInputUrl(initialUrl);
    setActiveUrl(sanitized);
    setHistory([sanitized]);
    setHistoryIndex(0);
    if (isScopeValid) {
      setHasError(false);
      setErrorMessage(null);
    }

    if (isNative && isScopeValid && sanitized !== lastRequestedUrlRef.current) {
      lastRequestedUrlRef.current = sanitized;
      void desktopBridge.portalNavigate(portalId, sanitized).catch((error: unknown) => {
        console.error(`Falha ao sincronizar URL do Portal ${portalId}`, error);
        setHasError(true);
      });
    }
  }, [initialUrl, isNative, portalId, isScopeValid, setHasError, setErrorMessage]);

  // 2. Native Webview2 View Instance Effect.
  // Dependencies depend on canonical validation values (validation.scope, validation.isValid)
  // rather than un-trimmed rawStorageScope strings.
  useEffect(() => {
    if (!isNative || !portalBodyRef.current) return;
    if (!isScopeValid) {
      setHasError(true);
      setErrorMessage(validation.errorMessage || `Escopo não suportado: "${validation.scope}"`);
      return;
    }

    let cancelled = false;
    let candidate: Webview | null = null;

    const createNativeWebview = async () => {
      try {
        const previous = await Webview.getByLabel(nativeLabel);
        await previous?.close().catch(() => undefined);
        if (cancelled || !portalBodyRef.current) return;
        const rect = portalBodyRef.current.getBoundingClientRect();
        candidate = new Webview(getCurrentWindow(), nativeLabel, {
          url: creationInitialUrlRef.current,
          x: Math.max(0, rect.left),
          y: Math.max(0, rect.top),
          width: Math.max(1, rect.width),
          height: Math.max(1, rect.height),
          incognito: incognitoOption,
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
  }, [isNative, nativeLabel, isScopeValid, validation.scope, validation.errorMessage, incognitoOption, setHasError, setErrorMessage]);

  // 3. Bounds Sync Effect
  useEffect(() => {
    if (!isNative || !isScopeValid) return;
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
  }, [isNative, isScopeValid]);

  const navigateTo = (rawUrl: string, isHistoryNav = false) => {
    const sanitized = sanitizeUrl(rawUrl);
    lastRequestedUrlRef.current = sanitized;
    setInputUrl(sanitized);
    setActiveUrl(sanitized);
    if (isScopeValid) setHasError(false);

    if (!isHistoryNav) {
      const newHistory = history.slice(0, historyIndex + 1);
      newHistory.push(sanitized);
      setHistory(newHistory);
      setHistoryIndex(newHistory.length - 1);
    }

    nodeData.onChangeURL?.(sanitized);

    if (isNative && isScopeValid && !isHistoryNav) {
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
    if (isScopeValid) setHasError(false);
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

        <span className={`portal-scope-badge ${isScopeValid ? validatedScope : "invalid"}`}>
          {isScopeValid ? validatedScope : "unsupported"}
        </span>

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
            <div className="portal-error-title">
              {errorMessage ? "Erro de Escopo de Armazenamento" : "Erro ao carregar página"}
            </div>
            <div className="portal-error-desc">
              {errorMessage || `Não foi possível carregar "${activeUrl}". Verifique o endereço ou conexões de rede.`}
            </div>
            {!errorMessage && (
              <button
                type="button"
                className="portal-error-retry-btn"
                onClick={handleReload}
              >
                Tentar novamente
              </button>
            )}
          </div>
        ) : isNative ? (
          <div className="portal-native-placeholder" aria-label="Portal WebView2 nativo">
            WebView2 nativo ativo ({validatedScope})
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
