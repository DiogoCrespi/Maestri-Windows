import type { Edge as ReactFlowEdge, Node as ReactFlowNode } from "@xyflow/react";

export interface AccessGraphNode {
  id: string;
  name: string;
  nodeType?: string;
  resourcePath?: string | null;
  isManager?: boolean;
}

export interface AccessGraphConnection {
  a: string;
  b: string;
}

export interface AccessGraphSnapshot {
  nodes: AccessGraphNode[];
  connections: AccessGraphConnection[];
}

export interface GraphIdentity {
  reactFlowNodeId: string;
  graphId: string;
  aliases: string[];
}

export interface GraphIdentityMap {
  identities: readonly GraphIdentity[];
  byReactFlowNodeId: ReadonlyMap<string, GraphIdentity>;
  byAlias: ReadonlyMap<string, GraphIdentity>;
  resolveReactFlowNodeId: (id: string | null | undefined) => string | undefined;
  resolveGraphId: (id: string | null | undefined) => string | undefined;
}

export type AccessGraphSyncState =
  | { phase: "idle"; revision: number }
  | { phase: "pending"; revision: number }
  | { phase: "synced"; revision: number; result: number }
  | { phase: "error"; revision: number; message: string };

export type AccessGraphReplace = (
  nodes: AccessGraphNode[],
  connections: AccessGraphConnection[],
) => Promise<number>;

// UUID parsing on the Rust side accepts the full hyphenated UUID shape,
// including nil/legacy version bits. Do not reject those before normalization.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function lookupKey(value: string): string {
  return value.trim().toLowerCase();
}

export function isGraphUuid(value: string): boolean {
  return UUID_PATTERN.test(value.trim());
}

function fnv1a32(value: string, seed: number): number {
  let hash = (0x811c9dc5 ^ seed) >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Stable UUID-shaped migration for old opaque IDs. It is not a security hash. */
export function deterministicLegacyGraphId(value: string): string {
  const input = value.trim();
  const words = [
    fnv1a32(`maestri:${input}`, 0),
    fnv1a32(`maestri:${input}`, 0x9e3779b9),
    fnv1a32(`graph:${input}`, 0x85ebca6b),
    fnv1a32(`legacy:${input}`, 0xc2b2ae35),
  ];
  const hex = words.map((word) => word.toString(16).padStart(8, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`.toLowerCase();
}

function graphContent(node: ReactFlowNode): Record<string, unknown> {
  const data = (node.data || {}) as Record<string, unknown>;
  return (data.content && typeof data.content === "object")
    ? data.content as Record<string, unknown>
    : data;
}

function graphIdentityCandidate(node: ReactFlowNode): string {
  const content = graphContent(node);
  return stringValue(content.graphId)
    || stringValue(content.id)
    || node.id;
}

function canonicalGraphId(candidate: string): string {
  return isGraphUuid(candidate) ? candidate.toLowerCase() : deterministicLegacyGraphId(candidate);
}

export function buildGraphIdentityMap(nodes: readonly ReactFlowNode[]): GraphIdentityMap {
  const identities: GraphIdentity[] = [];
  const byReactFlowNodeId = new Map<string, GraphIdentity>();
  const byAlias = new Map<string, GraphIdentity>();

  for (const node of nodes) {
    const content = graphContent(node);
    const candidate = graphIdentityCandidate(node);
    let graphId = canonicalGraphId(candidate);
    const collision = identities.find((identity) => identity.graphId === graphId);
    if (collision && collision.reactFlowNodeId !== node.id) {
      graphId = canonicalGraphId(`${candidate}|node:${node.id}`);
    }
    const aliases = [node.id, candidate, stringValue(content.id), stringValue(content.graphId)]
      .filter((value): value is string => Boolean(value));
    const identity: GraphIdentity = { reactFlowNodeId: node.id, graphId, aliases: [...new Set(aliases)] };
    identities.push(identity);
    byReactFlowNodeId.set(lookupKey(node.id), identity);
    for (const alias of identity.aliases) byAlias.set(lookupKey(alias), identity);
    byAlias.set(lookupKey(graphId), identity);
  }

  const resolve = (id: string | null | undefined): GraphIdentity | undefined => {
    if (!id) return undefined;
    return byAlias.get(lookupKey(id)) || byReactFlowNodeId.get(lookupKey(id));
  };

  return {
    identities,
    byReactFlowNodeId,
    byAlias,
    resolveReactFlowNodeId: (id) => resolve(id)?.reactFlowNodeId,
    resolveGraphId: (id) => resolve(id)?.graphId,
  };
}

function notePathFor(node: ReactFlowNode, workspacePath?: string): string | null {
  const content = graphContent(node);
  const storageMode = content.storageMode;
  if (storageMode && typeof storageMode === "object" && "custom" in storageMode) {
    const custom = (storageMode as { custom?: { _0?: unknown } }).custom?._0;
    return stringValue(custom) || null;
  }
  const fileName = stringValue(content.fileName);
  if (!fileName || !workspacePath) return null;
  const normalized = workspacePath.replace(/\\/g, "/");
  const separator = normalized.lastIndexOf("/");
  const directory = separator >= 0 ? normalized.slice(0, separator) : ".";
  return `${directory}/notes/${fileName}`;
}

export function buildAccessGraphSnapshot(
  nodes: readonly ReactFlowNode[],
  edges: readonly ReactFlowEdge[],
  workspacePath?: string,
): AccessGraphSnapshot {
  const identityMap = buildGraphIdentityMap(nodes);
  const graphNodes: AccessGraphNode[] = [];
  const published = new Set<string>();

  for (const node of nodes) {
    const identity = identityMap.identities.find((entry) => entry.reactFlowNodeId === node.id);
    if (!identity) continue;
    const content = graphContent(node);
    let graphNode: AccessGraphNode | null = null;
    if (node.type === "terminal") {
      graphNode = {
        id: identity.graphId,
        name: stringValue(content.name) || "Terminal",
        nodeType: "terminal",
        isManager: content.isManager === true,
      };
    } else if (node.type === "stickyNote") {
      const resourcePath = notePathFor(node, workspacePath);
      if (resourcePath) {
        graphNode = {
          id: identity.graphId,
          name: stringValue(content.title) || stringValue(content.fileName) || "Note",
          nodeType: "note",
          resourcePath,
        };
      }
    } else if (node.type === "portal") {
      graphNode = {
        id: identity.graphId,
        name: stringValue(content.name) || "Portal",
        nodeType: "portal",
      };
    }
    if (graphNode) {
      graphNodes.push(graphNode);
      published.add(identity.graphId);
    }
  }

  const connections = edges.flatMap((edge) => {
    const source = identityMap.resolveGraphId(edge.source);
    const target = identityMap.resolveGraphId(edge.target);
    if (!source || !target || !published.has(source) || !published.has(target)) return [];
    return [{ a: source, b: target }];
  });

  return { nodes: graphNodes, connections };
}

/** Latest-wins transport: stale responses/errors cannot update visible state. */
export class AccessGraphSynchronizer {
  private revision = 0;
  private latestSnapshot: AccessGraphSnapshot | null = null;
  private disposed = false;

  constructor(
    private readonly replace: AccessGraphReplace,
    private readonly onState: (state: AccessGraphSyncState) => void,
  ) {}

  enqueue(snapshot: AccessGraphSnapshot): number {
    if (this.disposed) return this.revision;
    const revision = ++this.revision;
    this.latestSnapshot = snapshot;
    this.onState({ phase: "pending", revision });
    void this.send(snapshot, revision);
    return revision;
  }

  retry(): number {
    return this.latestSnapshot ? this.enqueue(this.latestSnapshot) : this.revision;
  }

  dispose(): void {
    this.disposed = true;
    this.latestSnapshot = null;
  }

  private async send(snapshot: AccessGraphSnapshot, revision: number): Promise<void> {
    try {
      const result = await this.replace(snapshot.nodes, snapshot.connections);
      if (this.disposed || revision !== this.revision) return;
      this.onState({ phase: "synced", revision, result });
    } catch (error: unknown) {
      if (this.disposed || revision !== this.revision) return;
      this.onState({
        phase: "error",
        revision,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
