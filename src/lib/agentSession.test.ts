import { describe, expect, it } from "vitest";
import type { AgentSessionMetadata, TerminalContent } from "../model/workspace";
import {
  commandForPersistedAgentSession,
  isValidAgentSession,
  shouldClearAgentSession,
} from "./agentSession";

const codexSession: AgentSessionMetadata = {
  provider: "codex",
  sessionId: "11111111-2222-3333-4444-555555555555",
  capturedAt: "1787940000000",
};

describe("agent session adapters", () => {
  it("builds provider-specific exact resume commands", () => {
    expect(commandForPersistedAgentSession("codex", "codex", codexSession))
      .toBe('codex resume "11111111-2222-3333-4444-555555555555"');
    expect(commandForPersistedAgentSession("agy --model pro", "antGravity", {
      provider: "antGravity",
      sessionId: "conversation-42",
      capturedAt: "1787940000000",
    })).toBe('agy --model pro --conversation "conversation-42"');
    expect(commandForPersistedAgentSession("claude", "claudeCode", {
      provider: "claudeCode",
      sessionId: "claude-session-7",
      capturedAt: "1787940000000",
    })).toBe('claude --resume "claude-session-7"');
  });

  it("does not cross providers or duplicate explicit resume options", () => {
    expect(commandForPersistedAgentSession("agy", "antGravity", codexSession)).toBe("agy");
    expect(commandForPersistedAgentSession("codex resume manual", "codex", codexSession))
      .toBe("codex resume manual");
    expect(commandForPersistedAgentSession("agy --continue", "antGravity", {
      provider: "antGravity",
      sessionId: "conversation-42",
      capturedAt: "1787940000000",
    })).toBe("agy --continue");
  });

  it("gives every Antigravity terminal a dedicated capture log before resuming", () => {
    const session: AgentSessionMetadata = {
      provider: "antGravity",
      sessionId: "11111111-2222-4333-8444-555555555555",
      capturedAt: "1787940000000",
    };
    expect(commandForPersistedAgentSession(
      "agy --model default",
      "antGravity",
      session,
      "C:\\work\\.maestri\\agent-logs\\terminal-a.log",
    )).toBe(
      'agy --model default --log-file "C:\\work\\.maestri\\agent-logs\\terminal-a.log" --conversation "11111111-2222-4333-8444-555555555555"',
    );
    expect(commandForPersistedAgentSession(
      "agy",
      "antGravity",
      null,
      "C:\\work\\.maestri\\agent-logs\\terminal-a.log",
    )).toBe('agy --log-file "C:\\work\\.maestri\\agent-logs\\terminal-a.log"');
  });

  it("rejects unsafe IDs and clears stale sessions after provider changes", () => {
    expect(isValidAgentSession({ ...codexSession, sessionId: "bad;id" })).toBe(false);
    const content = { agentSession: codexSession } as TerminalContent;
    expect(shouldClearAgentSession(content, "codex", "codex --search")).toBe(false);
    expect(shouldClearAgentSession(content, "antGravity", "agy")).toBe(true);
    expect(shouldClearAgentSession(content, "codex", "powershell.exe")).toBe(true);
  });
});
