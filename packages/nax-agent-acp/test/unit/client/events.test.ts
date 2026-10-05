import { describe, expect, test } from "bun:test";
import type { TurnEvent } from "@nathapp/nax-agent";
import { createTurnCollector } from "#src/client/events";

describe("createTurnCollector (spec §6.7, text rows; D-e)", () => {
  test("agent text becomes text_delta (round 0) and the turn output", () => {
    const events: TurnEvent[] = [];
    const collector = createTurnCollector((e) => events.push(e));
    collector.onUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hel" } });
    collector.onUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "lo" } });
    expect(events).toEqual([
      { type: "text_delta", round: 0, text: "Hel" },
      { type: "text_delta", round: 0, text: "lo" },
    ]);
    expect(collector.output()).toBe("Hello");
  });

  test("non-text chunks, thoughts and tool updates are dropped until S4-5", () => {
    const events: TurnEvent[] = [];
    const collector = createTurnCollector((e) => events.push(e));
    collector.onUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "image", data: "AAAA", mimeType: "image/png" },
    });
    collector.onUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } });
    collector.onUpdate({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Read" });
    expect(events).toEqual([]);
    expect(collector.output()).toBe("");
  });

  test("a throwing sink does not break collection; no sink is allowed", () => {
    const collector = createTurnCollector(() => {
      throw new Error("sink broke");
    });
    collector.onUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } });
    expect(collector.output()).toBe("x");
    const silent = createTurnCollector(undefined);
    silent.onUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "y" } });
    expect(silent.output()).toBe("y");
  });
});
