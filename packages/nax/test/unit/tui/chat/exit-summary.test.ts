import { describe, expect, test } from "bun:test";
import type { ChatHostState } from "@/chat";
import { formatChatExitSummary } from "@/tui/chat";

function chatState(overrides: { sessionId?: string; costUsd?: number } = {}): ChatHostState {
  const sessionId = overrides.sessionId ?? "abc123";
  return {
    sessionId,
    mode: "guarded",
    model: "openai/gpt-6",
    meta: {
      schemaVersion: 1,
      sessionId,
      cwd: "/repo",
      mode: "ask",
      model: "openai/gpt-6",
      bashApproval: "gated",
      title: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: null,
      ...(overrides.costUsd === undefined ? {} : { costUsd: overrides.costUsd }),
    },
  };
}

describe("formatChatExitSummary", () => {
  test("AC-7: names the session and its spend, then how to resume it", () => {
    expect(formatChatExitSummary(chatState({ costUsd: 0.875 }))).toBe(
      "✻ nax chat session abc123 · $0.88\n  resume with: nax chat --resume abc123",
    );
  });

  test("reports $0.00 for a session whose meta carries no cost", () => {
    expect(formatChatExitSummary(chatState())).toBe(
      "✻ nax chat session abc123 · $0.00\n  resume with: nax chat --resume abc123",
    );
  });

  test("resumes the session it names, not a shortened id", () => {
    expect(formatChatExitSummary(chatState({ sessionId: "abc123def456", costUsd: 1 }))).toBe(
      "✻ nax chat session abc123def456 · $1.00\n  resume with: nax chat --resume abc123def456",
    );
  });
});
