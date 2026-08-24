import type { TerminalContent } from "../model/workspace";

export const MAESTRO_LIMITS = {
  id: 128,
  name: 128,
  role: 64,
  instructions: 8192,
  command: 8192,
  agentType: 128,
  workingDirectory: 4096,
  shellPath: 4096,
  color: 128,
  icon: 128,
} as const;

export type MaestroAction = "recruit" | "dismiss" | "connect" | "role";
export type MaestroConnectionType =
  | "terminal"
  | "terminal-note"
  | "terminal-portal"
  | "note-note"
  | "portal-portal";

export interface MaestroRecruitPayload {
  requestId: string;
  sourceTerminalId: string;
  name: string;
  role?: string;
  agentType?: string;
  command?: string;
  workingDirectory?: string;
  shellPath?: string;
  color?: string;
  icon?: string;
}

export interface MaestroDismissPayload {
  requestId: string;
  sourceTerminalId: string;
  targetTerminalId: string;
}

export interface MaestroConnectPayload {
  requestId: string;
  /** Authorized Manager actor. `sourceTerminalId` is accepted for legacy payloads. */
  actorTerminalId?: string;
  /** First graph endpoint; independent from the actor. */
  sourceId?: string;
  /** Legacy actor field; old payloads implied sourceId = actor. */
  sourceTerminalId?: string;
  targetId: string;
  connectionType?: MaestroConnectionType;
}

export interface MaestroRolePayload {
  requestId: string;
  sourceTerminalId: string;
  targetTerminalId: string;
  role: string;
  instructions?: string;
  color?: string;
}

export interface MaestroActionResult {
  requestId: string;
  action: MaestroAction;
  success: boolean;
  /** Strict ACK context derived from the received command by the controller. */
  actorTerminalId?: string;
  sourceId?: string;
  targetId?: string;
  edgeId?: string;
  error?: string;
}

export interface MaestroAckContext {
  actorTerminalId: string;
  sourceId?: string;
  targetId?: string;
}

export type MaestroPayload =
  | MaestroRecruitPayload
  | MaestroDismissPayload
  | MaestroConnectPayload
  | MaestroRolePayload;

export interface NormalizedMaestroConnectPayload {
  actorTerminalId: string;
  sourceId: string;
  targetId: string;
  connectionType?: MaestroConnectionType;
}

export function normalizeMaestroConnectPayload(
  payload: MaestroConnectPayload,
): NormalizedMaestroConnectPayload {
  const actorTerminalId = payload.actorTerminalId || payload.sourceTerminalId || "";
  return {
    actorTerminalId,
    sourceId: payload.sourceId || payload.sourceTerminalId || actorTerminalId,
    targetId: payload.targetId,
    connectionType: payload.connectionType,
  };
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function validateRequiredBounded(value: string, field: string, maxLength: number): string | undefined {
  if (!value.trim()) return `${field} is required`;
  if (Array.from(value).length > maxLength) return `${field} exceeds ${maxLength} characters`;
  return undefined;
}

function validateOptionalBounded(value: string | undefined, field: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  if (!value.trim()) return `${field} is required`;
  if (Array.from(value).length > maxLength) return `${field} exceeds ${maxLength} characters`;
  return undefined;
}

function validateOptionalText(value: string | undefined, field: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  if (Array.from(value).length > maxLength) return `${field} exceeds ${maxLength} characters`;
  if (Array.from(value).some((character) => character.charCodeAt(0) < 0x20)) {
    return `${field} contains control characters`;
  }
  return undefined;
}

export function validateMaestroPayload(
  action: MaestroAction,
  payload: MaestroPayload,
): string | undefined {
  if (!isUuid(payload.requestId)) return "requestId must be a UUID";
  const actorTerminalId = action === "connect" && "actorTerminalId" in payload
    ? payload.actorTerminalId
    : payload.sourceTerminalId;
  const actorError = validateRequiredBounded(
    actorTerminalId || "",
    action === "connect" ? "actorTerminalId" : "sourceTerminalId",
    MAESTRO_LIMITS.id,
  );
  const sourceError = actorError;
  if (sourceError) return sourceError;

  if (action === "recruit") {
    if (!("name" in payload)) return "Invalid recruit payload";
    const nameError = validateRequiredBounded(payload.name, "name", MAESTRO_LIMITS.name);
    if (nameError) return nameError;
    return validateOptionalBounded(payload.role, "role", MAESTRO_LIMITS.role)
      || validateOptionalText(payload.agentType, "agentType", MAESTRO_LIMITS.agentType)
      || validateOptionalText(payload.command, "command", MAESTRO_LIMITS.command)
      || validateOptionalText(payload.workingDirectory, "workingDirectory", MAESTRO_LIMITS.workingDirectory)
      || validateOptionalText(payload.shellPath, "shellPath", MAESTRO_LIMITS.shellPath)
      || validateOptionalText(payload.color, "color", MAESTRO_LIMITS.color)
      || validateOptionalText(payload.icon, "icon", MAESTRO_LIMITS.icon);
  }

  if (action === "role") {
    if (!("role" in payload) || !("targetTerminalId" in payload)) return "Invalid role payload";
    const rolePayload = payload as MaestroRolePayload;
    return validateRequiredBounded(rolePayload.role, "role", MAESTRO_LIMITS.role)
      || validateOptionalBounded(rolePayload.instructions, "instructions", MAESTRO_LIMITS.instructions);
  }

  if (action === "dismiss") {
    if (!("targetTerminalId" in payload)) return "Invalid dismiss payload";
    return validateRequiredBounded(payload.targetTerminalId, "targetTerminalId", MAESTRO_LIMITS.id);
  }

  if (!("targetId" in payload)) return "Invalid connect payload";
  const connectPayload = normalizeMaestroConnectPayload(payload as MaestroConnectPayload);
  return validateRequiredBounded(connectPayload.sourceId, "sourceId", MAESTRO_LIMITS.id)
    || validateRequiredBounded(connectPayload.targetId, "targetId", MAESTRO_LIMITS.id);
}

export function validateMaestroOrigin(
  sourceTerminalId: string,
  nodes: Array<{ id: string; type?: string; data?: Record<string, unknown> }>,
): { isValid: boolean; managerNode?: { id: string; position: { x: number; y: number }; data?: Record<string, unknown> }; error?: string } {
  if (!sourceTerminalId || !sourceTerminalId.trim()) {
    return { isValid: false, error: "sourceTerminalId is required" };
  }

  const foundNode = nodes.find((node) => node.id === sourceTerminalId);
  if (!foundNode) {
    return { isValid: false, error: `Source terminal '${sourceTerminalId}' not found in canvas` };
  }

  if (foundNode.type !== "terminal") {
    return { isValid: false, error: `Source node '${sourceTerminalId}' is not a terminal` };
  }

  const content = (foundNode.data?.content || {}) as Partial<TerminalContent>;
  if (!content.isManager) {
    return { isValid: false, error: `Terminal '${sourceTerminalId}' is not a Manager node` };
  }

  return { isValid: true, managerNode: foundNode as any };
}
