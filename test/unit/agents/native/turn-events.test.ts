import { describe, expect, test } from "bun:test";
import { buildNativeStreamEvent } from "@/agents/native/session/turn-events";

const base = { callId: "call-1", runId: "run-1", agentName: "native", sessionName: "sess-a" };

describe("native stream events", () => {
  test("maps a message activity to agent.message_update with its byte size", () => {
    const ev = buildNativeStreamEvent(base, { kind: "message", bytes: 42 }, 1000);
    expect(ev).toMatchObject({ kind: "agent.message_update", deltaBytes: 42, callId: "call-1", timestamp: 1000 });
  });

  test("maps a tool activity to agent.tool_call_update carrying the tool name", () => {
    const ev = buildNativeStreamEvent(base, { kind: "tool", toolName: "Write" }, 2000);
    expect(ev).toMatchObject({ kind: "agent.tool_call_update", toolName: "Write" });
  });

  test("maps a usage activity to agent.usage_update with tokens and cost", () => {
    const ev = buildNativeStreamEvent(base, { kind: "usage", inputTokens: 10, outputTokens: 3, costUsd: 0.5 }, 3000);
    expect(ev).toMatchObject({ kind: "agent.usage_update", inputTokens: 10, outputTokens: 3, costUsd: 0.5 });
  });

  test("maps a thinking activity to agent.thinking_update", () => {
    const ev = buildNativeStreamEvent(base, { kind: "thinking", bytes: 7 }, 4000);
    expect(ev).toMatchObject({ kind: "agent.thinking_update", deltaBytes: 7 });
  });
});
