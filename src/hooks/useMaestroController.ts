import { useEffect, useRef } from "react";
import { emit, listen, type EventCallback, type UnlistenFn } from "@tauri-apps/api/event";
import type { Edge as ReactFlowEdge, Node as ReactFlowNode } from "@xyflow/react";
import type { TerminalContent } from "../model/workspace";
import { classifyConnectionType, useWorkspaceStore, type WorkspaceConnectionType } from "../store/workspaceStore";
import {
  type MaestroAction,
  type MaestroActionResult,
  type MaestroAckContext,
  type MaestroConnectPayload,
  type MaestroDismissPayload,
  type MaestroPayload,
  type MaestroRecruitPayload,
  type MaestroRolePayload,
  normalizeMaestroConnectPayload,
  validateMaestroOrigin,
  validateMaestroPayload,
} from "../lib/maestroContract";
import { desktopBridge } from "../lib/desktopBridge";

const MAX_COMPLETED_REQUESTS = 1024;

export interface RequestClaim {
  accepted: boolean;
  replay?: MaestroActionResult;
}

/** Keeps retries idempotent while allowing a bounded amount of history. */
export class MaestroRequestTracker {
  private readonly inFlight = new Set<string>();
  private readonly completed = new Map<string, MaestroActionResult>();

  claim(requestId: string): RequestClaim {
    const replay = this.completed.get(requestId);
    if (replay) return { accepted: false, replay };
    if (this.inFlight.has(requestId)) return { accepted: false };
    this.inFlight.add(requestId);
    return { accepted: true };
  }

  complete(result: MaestroActionResult): void {
    this.inFlight.delete(result.requestId);
    this.completed.delete(result.requestId);
    this.completed.set(result.requestId, result);
    while (this.completed.size > MAX_COMPLETED_REQUESTS) {
      const oldest = this.completed.keys().next().value;
      if (!oldest) break;
      this.completed.delete(oldest);
    }
  }

  isProcessed(requestId: string): boolean {
    return this.inFlight.has(requestId) || this.completed.has(requestId);
  }

  clear(): void {
    this.inFlight.clear();
    this.completed.clear();
  }
}

const requestTracker = new MaestroRequestTracker();

export function isRequestProcessed(requestId: string): boolean {
  return requestTracker.isProcessed(requestId);
}

export function clearProcessedRequests(): void {
  requestTracker.clear();
}

export async function registerMaestroListener<T>(
  subscribe: (event: string, handler: EventCallback<T>) => Promise<UnlistenFn>,
  event: string,
  handler: EventCallback<T>,
  isMounted: () => boolean,
  addUnlisten: (unlisten: UnlistenFn) => void,
): Promise<void> {
  const unlisten = await subscribe(event, handler);
  if (isMounted()) addUnlisten(unlisten);
  else unlisten();
}

export interface RecruitedTerminal {
  node: ReactFlowNode;
  edge: ReactFlowEdge;
}

export function buildRecruitedTerminal(
  payload: MaestroRecruitPayload,
  managerNode: ReactFlowNode,
  idFactory: () => string = () => crypto.randomUUID(),
): RecruitedTerminal {
  const managerContent = (managerNode.data?.content || {}) as Partial<TerminalContent>;
  const terminalId = idFactory();
  const width = typeof managerNode.style?.width === "number" ? managerNode.style.width : 450;
  const height = typeof managerNode.style?.height === "number" ? managerNode.style.height : 320;
  const agentType = payload.agentType?.trim() || "claude_code";
  const shellPath = payload.shellPath?.trim() || managerContent.shellPath?.trim() || "powershell.exe";
  const requestedCommand = payload.command?.trim();
  const command = requestedCommand && requestedCommand.localeCompare(shellPath, undefined, { sensitivity: "accent" }) !== 0
    ? requestedCommand
    : "";

  const content: TerminalContent = {
    // The canvas node and its terminal content share one identity.
    id: terminalId,
    agentType,
    command,
    name: payload.name.trim(),
    icon: payload.icon?.trim() || "terminal",
    color: payload.color?.trim() || "#3b82f6",
    shellPath,
    workingDirectory: payload.workingDirectory?.trim() || managerContent.workingDirectory?.trim() || "C:\\",
    status: "idle",
    isManager: false,
    monitorWithOmbro: false,
    autoScrollLocked: false,
    shortcutMode: { kind: "automatic" },
    scrollbackLineCount: 0,
    assignedRoleId: payload.role?.trim() || null,
  };

  const node: ReactFlowNode = {
    id: terminalId,
    type: "terminal",
    position: { x: managerNode.position.x, y: managerNode.position.y + height + 60 },
    style: { width, height },
    dragHandle: ".drag-handle",
    data: { content, contentVariant: "terminal" },
  };
  const edge: ReactFlowEdge = {
    id: `e-${managerNode.id}-${terminalId}`,
    source: managerNode.id,
    target: terminalId,
    type: "default",
    data: {
      createdAt: new Date().toISOString(),
      ropePoints: [],
      connectionType: "terminal",
    },
  };
  return { node, edge };
}

export function classifyMaestroConnection(
  sourceType: string | undefined,
  targetType: string | undefined,
): WorkspaceConnectionType | null {
  return classifyConnectionType(sourceType, targetType);
}

/** Derives ACK identity/endpoints from the canonical command being handled. */
export function deriveMaestroAckContext(
  action: MaestroAction,
  payload: MaestroPayload,
): MaestroAckContext {
  if (action === "connect") {
    const normalized = normalizeMaestroConnectPayload(payload as MaestroConnectPayload);
    return {
      actorTerminalId: normalized.actorTerminalId,
      sourceId: normalized.sourceId,
      targetId: normalized.targetId,
    };
  }

  if (action === "recruit") {
    return { actorTerminalId: (payload as MaestroRecruitPayload).sourceTerminalId };
  }

  const request = payload as MaestroDismissPayload | MaestroRolePayload;
  return {
    actorTerminalId: request.sourceTerminalId,
    targetId: request.targetTerminalId,
  };
}

/** Adds only command-derived context; endpoint results are never used as identity. */
export function withMaestroAckContext(
  result: MaestroActionResult,
  context: MaestroAckContext,
): MaestroActionResult {
  return {
    ...result,
    actorTerminalId: context.actorTerminalId,
    ...(context.sourceId === undefined ? {} : { sourceId: context.sourceId }),
    ...(context.targetId === undefined ? {} : { targetId: context.targetId }),
  };
}

async function sendAck(result: MaestroActionResult): Promise<void> {
  if (!desktopBridge.isNative) return;
  try {
    await emit("maestro://result", result);
  } catch {
    // Native event delivery is best-effort; the local mutation remains authoritative.
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useMaestroController(): void {
  const nodes = useWorkspaceStore((state) => state.nodes);
  const edges = useWorkspaceStore((state) => state.edges);
  const setNodes = useWorkspaceStore((state) => state.setNodes);
  const setEdges = useWorkspaceStore((state) => state.setEdges);

  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const edgesRef = useRef(edges);
  edgesRef.current = edges;

  useEffect(() => {
    if (!desktopBridge.isNative) return;

    let mounted = true;
    const unlistens: UnlistenFn[] = [];
    const actionQueue = { current: Promise.resolve() };
    const commitNodes = (nextNodes: ReactFlowNode[]) => {
      nodesRef.current = nextNodes;
      setNodes(nextNodes);
    };
    const commitEdges = (nextEdges: ReactFlowEdge[]) => {
      edgesRef.current = nextEdges;
      setEdges(nextEdges);
    };

    const finish = async (result: MaestroActionResult, context: MaestroAckContext) => {
      const enriched = withMaestroAckContext(result, context);
      requestTracker.complete(enriched);
      await sendAck(enriched);
    };

    const execute = async <T extends MaestroPayload>(
      action: MaestroAction,
      payload: T,
      operation: (payload: T) => Promise<MaestroActionResult>,
    ): Promise<void> => {
      if (!mounted || !payload?.requestId) return;
      const claim = requestTracker.claim(payload.requestId);
      if (!claim.accepted) {
        if (claim.replay) await sendAck(claim.replay);
        return;
      }

      const ackContext = deriveMaestroAckContext(action, payload);

      const validationError = validateMaestroPayload(action, payload);
      if (validationError) {
        await finish({ requestId: payload.requestId, action, success: false, error: validationError }, ackContext);
        return;
      }

      try {
        await finish(await operation(payload), ackContext);
      } catch (error) {
        await finish({ requestId: payload.requestId, action, success: false, error: errorMessage(error) }, ackContext);
      }
    };

    const dispatch = <T extends MaestroPayload>(
      action: MaestroAction,
      payload: T,
      operation: (payload: T) => Promise<MaestroActionResult>,
    ) => {
      if (!mounted || !payload?.requestId) return;
      actionQueue.current = actionQueue.current
        .catch(() => undefined)
        .then(() => execute(action, payload, operation));
    };

    const recruit: EventCallback<MaestroRecruitPayload> = ({ payload }) => {
      dispatch("recruit", payload, async (request) => {
        const validation = validateMaestroOrigin(request.sourceTerminalId, nodesRef.current);
        if (!validation.isValid || !validation.managerNode) {
          return { requestId: request.requestId, action: "recruit", success: false, error: validation.error };
        }
        const { node, edge } = buildRecruitedTerminal(request, validation.managerNode as ReactFlowNode);
        commitNodes([...nodesRef.current, node]);
        commitEdges([...edgesRef.current, edge]);
        return { requestId: request.requestId, action: "recruit", success: true, targetId: node.id, edgeId: edge.id };
      });
    };

    const dismiss: EventCallback<MaestroDismissPayload> = ({ payload }) => {
      dispatch("dismiss", payload, async (request) => {
        const validation = validateMaestroOrigin(request.sourceTerminalId, nodesRef.current);
        if (!validation.isValid) {
          return { requestId: request.requestId, action: "dismiss", success: false, error: validation.error };
        }
        if (request.targetTerminalId === request.sourceTerminalId) {
          return { requestId: request.requestId, action: "dismiss", success: false, error: "A Manager terminal cannot dismiss itself" };
        }
        const target = nodesRef.current.find((node) => node.id === request.targetTerminalId);
        if (!target || target.type !== "terminal") {
          return { requestId: request.requestId, action: "dismiss", success: false, error: `Target terminal '${request.targetTerminalId}' not found` };
        }
        commitNodes(nodesRef.current.filter((node) => node.id !== request.targetTerminalId));
        commitEdges(edgesRef.current.filter((edge) => edge.source !== request.targetTerminalId && edge.target !== request.targetTerminalId));
        return { requestId: request.requestId, action: "dismiss", success: true, targetId: request.targetTerminalId };
      });
    };

    const connect: EventCallback<MaestroConnectPayload> = ({ payload }) => {
      dispatch("connect", payload, async (request) => {
        const normalized = normalizeMaestroConnectPayload(request);
        const validation = validateMaestroOrigin(normalized.actorTerminalId, nodesRef.current);
        if (!validation.isValid || !validation.managerNode) {
          return { requestId: request.requestId, action: "connect", success: false, error: validation.error };
        }
        if (normalized.targetId === normalized.sourceId) {
          return { requestId: request.requestId, action: "connect", success: false, error: "A node cannot connect to itself" };
        }
        const source = nodesRef.current.find((node) => node.id === normalized.sourceId);
        const target = nodesRef.current.find((node) => node.id === normalized.targetId);
        if (!source || !target) {
          const missing = source ? normalized.targetId : normalized.sourceId;
          return { requestId: request.requestId, action: "connect", success: false, error: `Connection node '${missing}' not found` };
        }
        const connectionType = classifyMaestroConnection(source.type, target.type);
        if (!connectionType) {
          return { requestId: request.requestId, action: "connect", success: false, error: `Connection between '${source.type}' and '${target.type}' is not supported` };
        }
        if (normalized.connectionType && normalized.connectionType !== connectionType) {
          return { requestId: request.requestId, action: "connect", success: false, error: "Connection type does not match endpoint types" };
        }
        const existingEdge = edgesRef.current.find((edge) =>
          (edge.source === normalized.sourceId && edge.target === normalized.targetId)
          || (edge.source === normalized.targetId && edge.target === normalized.sourceId));
        if (existingEdge) {
          return { requestId: request.requestId, action: "connect", success: true, targetId: normalized.targetId, edgeId: existingEdge.id };
        }
        const edge: ReactFlowEdge = {
          id: `e-${normalized.sourceId}-${normalized.targetId}`,
          source: normalized.sourceId,
          target: normalized.targetId,
          type: "default",
          data: { createdAt: new Date().toISOString(), ropePoints: [], connectionType },
        };
        commitEdges([...edgesRef.current, edge]);
        return { requestId: request.requestId, action: "connect", success: true, targetId: request.targetId, edgeId: edge.id };
      });
    };

    const role: EventCallback<MaestroRolePayload> = ({ payload }) => {
      dispatch("role", payload, async (request) => {
        const validation = validateMaestroOrigin(request.sourceTerminalId, nodesRef.current);
        if (!validation.isValid) {
          return { requestId: request.requestId, action: "role", success: false, error: validation.error };
        }
        const target = nodesRef.current.find((node) => node.id === request.targetTerminalId);
        if (!target || target.type !== "terminal") {
          return { requestId: request.requestId, action: "role", success: false, error: `Target terminal '${request.targetTerminalId}' not found` };
        }
        const updatedNodes = nodesRef.current.map((node) => {
          if (node.id !== request.targetTerminalId) return node;
          const content = (node.data?.content || {}) as TerminalContent & { instructions?: string };
          return {
            ...node,
            data: {
              ...node.data,
              content: {
                ...content,
                assignedRoleId: request.role,
                ...(request.instructions === undefined ? {} : { instructions: request.instructions }),
                color: request.color || content.color,
              },
            },
          };
        });
        commitNodes(updatedNodes);
        return { requestId: request.requestId, action: "role", success: true, targetId: request.targetTerminalId };
      });
    };

    void Promise.all([
      registerMaestroListener(listen, "maestro://recruit", recruit, () => mounted, (fn) => unlistens.push(fn)),
      registerMaestroListener(listen, "maestro://dismiss", dismiss, () => mounted, (fn) => unlistens.push(fn)),
      registerMaestroListener(listen, "maestro://connect", connect, () => mounted, (fn) => unlistens.push(fn)),
      registerMaestroListener(listen, "maestro://role", role, () => mounted, (fn) => unlistens.push(fn)),
    ]).catch(() => undefined);

    return () => {
      mounted = false;
      unlistens.splice(0).forEach((unlisten) => unlisten());
      requestTracker.clear();
    };
  }, [setEdges, setNodes]);
}
