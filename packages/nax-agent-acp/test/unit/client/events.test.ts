import { describe, expect, test } from "bun:test";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { TurnEvent } from "@nathapp/nax-agent";
import { createTurnCollector } from "#src/client/events";
import { UNANSWERED_PREVIEW } from "#src/client/tool-events";
import { createCostMeter } from "#src/client/usage";

const SECRET = "s3cr3t-token-value-0123";

const say = (text: string): SessionUpdate => ({
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text },
});
const think = (text: string): SessionUpdate => ({
  sessionUpdate: "agent_thought_chunk",
  content: { type: "text", text },
});

function setup(secrets: readonly string[] = []) {
  const events: TurnEvent[] = [];
  const collector = createTurnCollector((e) => events.push(e), { secrets });
  return { events, collector };
}

describe("createTurnCollector: text and thoughts (spec §6.7, D5-g)", () => {
  test("agent text is text_delta and the output; thoughts are thinking_delta and not output", () => {
    const { events, collector } = setup();
    collector.onUpdate(say("Hel"));
    collector.onUpdate(think("hmm"));
    collector.onUpdate(say("lo"));
    expect(events).toEqual([
      { type: "text_delta", round: 0, text: "Hel" },
      { type: "thinking_delta", round: 0, text: "hmm" },
      { type: "text_delta", round: 0, text: "lo" },
    ]);
    expect(collector.output()).toBe("Hello");
  });

  test("a secret split across text chunks never reaches a delta whole or in joinable parts", () => {
    const { events, collector } = setup([SECRET]);
    collector.onUpdate(say("key s3cr3t-tok"));
    collector.onUpdate(say("en-value-0123 ok"));
    collector.finish();
    const deltas = events.flatMap((e) => (e.type === "text_delta" ? [e.text] : []));
    expect(deltas.join("")).toBe("key [REDACTED] ok");
    expect(collector.output()).toBe("key [REDACTED] ok");
  });

  test("held text flushes before the other stream and before tool events, keeping the order", () => {
    const { events, collector } = setup([SECRET]);
    collector.onUpdate(say("before"));
    collector.onUpdate(think("thinking"));
    collector.onUpdate({ sessionUpdate: "tool_call", toolCallId: "c1", title: "Read", status: "in_progress" });
    collector.onUpdate(say("after"));
    collector.finish();
    expect(events.map((e) => e.type)).toEqual([
      "text_delta",
      "thinking_delta",
      "tool_call",
      "text_delta",
      "tool_result",
    ]);
  });

  test("non-text chunks, user chunks, plans and mode updates are dropped", () => {
    const { events, collector } = setup();
    collector.onUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "image", data: "AA", mimeType: "image/png" },
    });
    collector.onUpdate({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "me" } });
    collector.onUpdate({ sessionUpdate: "plan", entries: [] });
    collector.onUpdate({ sessionUpdate: "current_mode_update", currentModeId: "plan" });
    collector.finish();
    expect(events).toEqual([]);
    expect(collector.output()).toBe("");
  });
});

describe("createTurnCollector: tools, finish and settle (D5-c, D5-e, D5-h)", () => {
  test("announce emits tool_call; finish answers it as not answered; nothing after finish", () => {
    const { events, collector } = setup();
    collector.announce({ toolCallId: "p1", title: "Edit a file", kind: "edit" });
    collector.finish();
    collector.onUpdate(say("late"));
    collector.announce({ toolCallId: "p2", title: "Late" });
    collector.finish();
    expect(events).toEqual([
      { type: "tool_call", callId: "p1", name: "Edit a file", input: {} },
      { type: "tool_result", callId: "p1", isError: true, preview: UNANSWERED_PREVIEW },
    ]);
  });

  test("settle emits one usage event after the last delta, with the meter's cost", () => {
    const events: TurnEvent[] = [];
    const meter = createCostMeter();
    const collector = createTurnCollector((e) => events.push(e), { secrets: [SECRET], meter });
    collector.onUpdate(say("tail s3cr3t"));
    collector.onUpdate({ sessionUpdate: "usage_update", used: 10, size: 100, cost: { amount: 0.02, currency: "USD" } });
    const spend = collector.settle({
      stopReason: "end_turn",
      usage: { totalTokens: 15, inputTokens: 10, outputTokens: 5 },
    });
    expect(spend).toEqual({ tokenUsage: { inputTokens: 10, outputTokens: 5 }, costUsd: 0.02, costSource: "reported" });
    expect(events.map((e) => e.type)).toEqual(["text_delta", "usage"]);
    expect(events.at(-1)).toEqual({
      type: "usage",
      round: 0,
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.02,
      costSource: "reported",
    });
    expect(collector.settle({ stopReason: "end_turn" })).toBe(spend);
    expect(events.filter((e) => e.type === "usage")).toHaveLength(1);
  });

  test("the collector starts a meter turn: a reading from an unsettled earlier turn is forgotten", () => {
    const meter = createCostMeter();
    meter.beginTurn();
    meter.observe({ amount: 1, currency: "USD" });
    const collector = createTurnCollector(undefined, { meter });
    expect(collector.settle({ stopReason: "end_turn" }).costSource).toBe("unpriced");
  });

  test("a throwing sink does not break collection; no sink is allowed", () => {
    const collector = createTurnCollector(() => {
      throw new Error("sink broke");
    });
    collector.onUpdate(say("x"));
    expect(collector.output()).toBe("x");
    const silent = createTurnCollector(undefined);
    silent.onUpdate(say("y"));
    expect(silent.settle({ stopReason: "end_turn" }).costSource).toBe("unpriced");
    expect(silent.output()).toBe("y");
  });
});
