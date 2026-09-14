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

  test("forwards cacheRead and cacheWrite when the usage activity carries them", () => {
    const ev = buildNativeStreamEvent(
      base,
      { kind: "usage", inputTokens: 10, outputTokens: 3, costUsd: 0.5, cacheRead: 100, cacheWrite: 20 },
      3000,
    );
    expect(ev).toMatchObject({ kind: "agent.usage_update", cacheRead: 100, cacheWrite: 20 });
  });

  test("leaves cacheRead and cacheWrite absent, not 0, when the activity carries no cache data", () => {
    const ev = buildNativeStreamEvent(base, { kind: "usage", inputTokens: 10, outputTokens: 3, costUsd: 0.5 }, 3000);
    expect("cacheRead" in ev).toBe(false);
    expect("cacheWrite" in ev).toBe(false);
  });

  test("keeps an explicit zero cacheRead distinct from an absent one", () => {
    const ev = buildNativeStreamEvent(
      base,
      { kind: "usage", inputTokens: 10, outputTokens: 3, costUsd: 0.5, cacheRead: 0 },
      3000,
    );
    expect(ev).toHaveProperty("cacheRead", 0);
  });

  test("forwards the round-trip ordinal and marks the event a round-trip boundary", () => {
    const ev = buildNativeStreamEvent(
      base,
      { kind: "usage", inputTokens: 10, outputTokens: 3, costUsd: 0.5, roundTrip: 1 },
      3000,
    );
    expect(ev).toMatchObject({ kind: "agent.usage_update", roundTrip: 1, perRoundTrip: true, cadence: "round-trip" });
  });

  test("a usage activity with no round-trip ordinal is not a round-trip boundary", () => {
    const ev = buildNativeStreamEvent(base, { kind: "usage", inputTokens: 0, outputTokens: 0, costUsd: 0 }, 3000);
    expect("roundTrip" in ev).toBe(false);
    expect("perRoundTrip" in ev).toBe(false);
    expect(ev).toMatchObject({ kind: "agent.usage_update", cadence: "round-trip" });
  });
});
