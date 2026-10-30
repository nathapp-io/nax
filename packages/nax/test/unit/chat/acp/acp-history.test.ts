import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@nathapp/nax-agent";
import {
  ACP_TOOL_NAME_MAX_CHARS,
  ACP_TOOL_SUMMARY_LIMIT,
  acpAgentOfMessage,
  acpOrigin,
  acpTurnMessages,
  type ChatMessage,
} from "@/chat/acp/acp-history";
import type { ChatAcpModel } from "@/chat/acp/acp-model";

const base = { sessionId: "s", turnId: "t", at: "2026-10-01T00:00:00.000Z", metadata: {} };
const CODEX: ChatAcpModel = { agent: "codex", model: "gpt-5.5" };

function textDelta(text: string): SessionEvent {
  return { ...base, type: "text_delta", round: 1, text };
}
function thinkingDelta(text: string): SessionEvent {
  return { ...base, type: "thinking_delta", round: 1, text };
}
const reset: SessionEvent = { ...base, type: "stream_reset", round: 1, attempt: 1 };
function toolCall(callId: string, name: string, input: unknown = {}): SessionEvent {
  return { ...base, type: "tool_call", callId, name, input };
}
function toolResult(callId: string, isError = false, preview = ""): SessionEvent {
  return { ...base, type: "tool_result", callId, isError, preview };
}
function turnEnd(output: string, status: "completed" | "cancelled" = "completed"): SessionEvent {
  return { ...base, type: "turn_end", status, output, usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0 };
}

function assistantContent(events: readonly SessionEvent[], acp: ChatAcpModel = CODEX): string {
  const assistant = acpTurnMessages({ message: "hi", events, acp })[1];
  if (assistant.role !== "assistant") throw new Error("expected an assistant message");
  return assistant.content;
}

describe("acpOrigin", () => {
  test("names the provider and the model", () => {
    expect(acpOrigin({ agent: "codex", model: "gpt-5.5" })).toEqual({ provider: "acp:codex", model: "gpt-5.5" });
  });

  test("uses default when no model is named", () => {
    expect(acpOrigin({ agent: "claude" })).toEqual({ provider: "acp:claude", model: "default" });
  });

  test("leaves the effort out", () => {
    expect(acpOrigin({ agent: "codex", model: "gpt-5.5", effort: "high" })).toEqual({
      provider: "acp:codex",
      model: "gpt-5.5",
    });
  });
});

describe("acpAgentOfMessage", () => {
  const assistant = (origin?: { provider: string; model: string }): ChatMessage => ({
    role: "assistant",
    content: "x",
    ...(origin ? { origin } : {}),
  });

  test("returns the agent of an acp origin", () => {
    expect(acpAgentOfMessage(assistant({ provider: "acp:cursor", model: "default" }))).toBe("cursor");
  });

  test("returns undefined for a user message", () => {
    expect(acpAgentOfMessage({ role: "user", content: "x" })).toBeUndefined();
  });

  test("returns undefined when there is no origin", () => {
    expect(acpAgentOfMessage(assistant())).toBeUndefined();
  });

  test("returns undefined for a native provider", () => {
    expect(acpAgentOfMessage(assistant({ provider: "openai", model: "gpt" }))).toBeUndefined();
  });

  test("returns undefined for an acp agent that is not a chat agent", () => {
    expect(acpAgentOfMessage(assistant({ provider: "acp:gemini", model: "default" }))).toBeUndefined();
  });
});

describe("acpTurnMessages", () => {
  test("returns the user message first, then the assistant message", () => {
    const messages = acpTurnMessages({ message: "hi", events: [turnEnd("ok")], acp: CODEX });
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: "user", content: "hi" });
    expect(messages[1].role).toBe("assistant");
  });

  test("prefers the turn_end output over the deltas", () => {
    expect(assistantContent([textDelta("x"), turnEnd("Hello world")])).toBe("Hello world");
  });

  test("concatenates text deltas when the output is empty", () => {
    expect(assistantContent([textDelta("Hel"), textDelta("lo"), turnEnd("")])).toBe("Hello");
  });

  test("discards text collected before a stream_reset", () => {
    expect(assistantContent([textDelta("a"), reset, textDelta("b"), turnEnd("")])).toBe("b");
  });

  test("never records thinking text", () => {
    expect(assistantContent([textDelta("ok"), thinkingDelta("secret plan"), turnEnd("")])).toBe("ok");
  });

  test("writes one line per tool call after the text, in call order", () => {
    const events = [
      textDelta("done"),
      toolCall("1", "Read"),
      toolResult("1"),
      toolCall("2", "Bash"),
      toolResult("2"),
      turnEnd(""),
    ];
    expect(assistantContent(events)).toBe("done\n[tool] Read\n[tool] Bash");
  });

  test("marks a tool whose result is an error", () => {
    const events = [toolCall("1", "Bash"), toolResult("1", true), turnEnd("")];
    expect(assistantContent(events)).toBe("[tool] Bash (error)");
  });

  test("pairs a result with its call by callId, not by order", () => {
    const events = [toolCall("1", "Read"), toolCall("2", "Bash"), toolResult("2", true), toolResult("1"), turnEnd("")];
    expect(assistantContent(events)).toBe("[tool] Read\n[tool] Bash (error)");
  });

  test("caps the lines at the summary limit and counts the rest", () => {
    const calls = Array.from({ length: 23 }, (_, i) => toolCall(String(i), `T${i}`));
    const lines = assistantContent([...calls, turnEnd("")]).split("\n");
    expect(ACP_TOOL_SUMMARY_LIMIT).toBe(20);
    expect(lines).toHaveLength(21);
    expect(lines.slice(0, 20)).toEqual(Array.from({ length: 20 }, (_, i) => `[tool] T${i}`));
    expect(lines[20]).toBe("[tool] … and 3 more");
  });

  test("writes exactly the limit with no overflow line", () => {
    const calls = Array.from({ length: 20 }, (_, i) => toolCall(String(i), `T${i}`));
    const lines = assistantContent([...calls, turnEnd("")]).split("\n");
    expect(lines).toHaveLength(20);
    expect(lines.at(-1)).toBe("[tool] T19");
  });

  test("cuts a long tool name to its first 80 code points", () => {
    const name = "a".repeat(100);
    expect(ACP_TOOL_NAME_MAX_CHARS).toBe(80);
    expect(assistantContent([toolCall("1", name), turnEnd("")])).toBe(`[tool] ${"a".repeat(80)}`);
  });

  test("counts code points, not UTF-16 units, when cutting a name", () => {
    const name = "😀".repeat(100);
    expect(assistantContent([toolCall("1", name), turnEnd("")])).toBe(`[tool] ${"😀".repeat(80)}`);
  });

  test("never records a tool input or result preview", () => {
    const events = [toolCall("1", "Read", { token: "abc" }), toolResult("1", false, "abc"), turnEnd("")];
    const content = assistantContent(events);
    expect(content).toBe("[tool] Read");
    expect(content).not.toContain("abc");
  });

  test("describes a turn with neither text nor tool calls", () => {
    expect(assistantContent([thinkingDelta("hm"), turnEnd("", "cancelled")])).toBe("(no reply; turn cancelled)");
  });

  test("gives the assistant message exactly role, content and origin", () => {
    const assistant = acpTurnMessages({ message: "hi", events: [turnEnd("ok")], acp: CODEX })[1];
    expect(Object.keys(assistant).sort()).toEqual(["content", "origin", "role"]);
    expect(assistant.role === "assistant" && assistant.origin).toEqual(acpOrigin(CODEX));
  });
});
