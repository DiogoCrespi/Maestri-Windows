import type {
  AgentSessionMetadata,
  AgentSessionProvider,
  TerminalContent,
} from "../model/workspace";

const SAFE_SESSION_ID = /^[A-Za-z0-9_.:-]{1,256}$/;

const PROVIDER_EXECUTABLES: Record<AgentSessionProvider, string> = {
  codex: "codex",
  antGravity: "agy",
  claudeCode: "claude",
};

export function providerForAgentType(agentType: string | undefined): AgentSessionProvider | null {
  switch (agentType?.trim().toLowerCase()) {
    case "codex":
      return "codex";
    case "antgravity":
    case "ant_gravity":
      return "antGravity";
    case "claudecode":
    case "claude_code":
    case "claude":
      return "claudeCode";
    default:
      return null;
  }
}

export function isValidAgentSession(value: unknown): value is AgentSessionMetadata {
  if (!value || typeof value !== "object") return false;
  const session = value as Partial<AgentSessionMetadata>;
  return providerForAgentType(session.provider) === session.provider
    && typeof session.sessionId === "string"
    && SAFE_SESSION_ID.test(session.sessionId)
    && typeof session.capturedAt === "string"
    && session.capturedAt.length > 0
    && session.capturedAt.length <= 64;
}

function commandStartsWithExecutable(command: string, executable: string): boolean {
  const escaped = executable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `^\\s*(?:"[^"]*[\\\\/]${escaped}(?:\\.exe)?"|${escaped}(?:\\.exe)?)(?=\\s|$)`,
    "i",
  );
  return pattern.test(command);
}

function alreadyResumes(command: string, provider: AgentSessionProvider): boolean {
  switch (provider) {
    case "codex":
      return /(?:^|\s)resume(?:\s|$)/i.test(command);
    case "antGravity":
      return /(?:^|\s)(?:--conversation|--continue|-c)(?:\s|$)/i.test(command);
    case "claudeCode":
      return /(?:^|\s)(?:--resume|-r)(?:\s|$)/i.test(command);
  }
}

export function commandForPersistedAgentSession(
  command: string | undefined,
  agentType: string | undefined,
  session: AgentSessionMetadata | null | undefined,
  agentLogPath?: string | null,
): string | undefined {
  const original = command?.trim();
  if (!original) return undefined;
  const provider = providerForAgentType(agentType);
  if (!provider || !commandStartsWithExecutable(original, PROVIDER_EXECUTABLES[provider])) {
    return original;
  }
  let launchCommand = original;
  if (
    provider === "antGravity"
    && agentLogPath?.trim()
    && !/[\s](?:--log-file)(?:\s|=)/i.test(launchCommand)
    && !agentLogPath.includes('"')
  ) {
    launchCommand = `${launchCommand} --log-file "${agentLogPath.trim()}"`;
  }
  if (
    !session
    || !isValidAgentSession(session)
    || provider !== session.provider
    || alreadyResumes(launchCommand, provider)
  ) {
    return launchCommand;
  }
  const quotedId = `"${session.sessionId}"`;
  switch (provider) {
    case "codex":
      return `${launchCommand} resume ${quotedId}`;
    case "antGravity":
      return `${launchCommand} --conversation ${quotedId}`;
    case "claudeCode":
      return `${launchCommand} --resume ${quotedId}`;
  }
}

export function shouldClearAgentSession(
  content: TerminalContent,
  nextAgentType: string | undefined,
  nextCommand: string | undefined,
): boolean {
  if (!content.agentSession) return false;
  const nextProvider = providerForAgentType(nextAgentType);
  if (nextProvider !== content.agentSession.provider) return true;
  return !commandStartsWithExecutable(
    nextCommand?.trim() ?? "",
    PROVIDER_EXECUTABLES[nextProvider],
  );
}
