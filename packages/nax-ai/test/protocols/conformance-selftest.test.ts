/**
 * Proves the conformance suite actually fails on a violating protocol.
 * A suite nobody has seen fail is not yet a suite.
 */
import { describe, expect, it } from "vitest";
import type { Protocol, ProtocolEvent, ProtocolRequest } from "../../src/protocols/types.ts";
import { runProtocolConformance, sequenceViolations } from "../support/conformance.ts";

const TEXT_REQUEST: ProtocolRequest = {
  model: "fake-model",
  messages: [{ role: "user", content: "hi" }],
};

const scripted = (name: string, events: ProtocolEvent[]): Protocol => ({
  name,
  async *stream() {
    for (const event of events) yield event;
  },
});

const GOOD: ProtocolEvent[] = [
  { type: "text-delta", text: "hello" },
  { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } },
  { type: "done", stopReason: "stop" },
];

runProtocolConformance("compliant fake", async () => scripted("fake", GOOD), {
  text: { name: "text", request: TEXT_REQUEST },
});

describe("conformance suite self-test", () => {
  it("detects usage emitted after done", async () => {
    const bad = scripted("bad", [
      { type: "text-delta", text: "hi" },
      { type: "done", stopReason: "stop" },
      { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const events: ProtocolEvent[] = [];
    for await (const event of bad.stream(TEXT_REQUEST)) events.push(event);
    // The suite asserts on sequenceViolations, so the helper — not an inline
    // re-implementation — must be what flags this stream.
    expect(sequenceViolations(events).length).toBeGreaterThan(0);
    expect(sequenceViolations(events)).not.toEqual([]);
    expect(sequenceViolations(events)).toContain("usage must precede done");
  });
});
