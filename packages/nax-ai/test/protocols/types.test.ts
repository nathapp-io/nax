// test/protocols/types.test.ts
import { describe, expect, it } from "vitest";
import { PROTOCOL_ERROR_KINDS, PROTOCOL_EVENT_TYPES, THINKING_LEVELS } from "../../src/protocols/types.ts";

describe("protocol discriminants", () => {
  it("declares exactly the eight event types the spec names", () => {
    // "thinking" was added for the thinking-block round-trip fix: it carries
    // the durable complete block, alongside "thinking-delta"'s display-only
    // partial — the same pairing "tool-call-partial"/"tool-call" already use.
    expect([...PROTOCOL_EVENT_TYPES]).toEqual([
      "text-delta",
      "thinking-delta",
      "thinking",
      "tool-call-partial",
      "tool-call",
      "usage",
      "error",
      "done",
    ]);
  });

  it("declares the seven error kinds", () => {
    // "context-overflow" sits beside "bad-request" because it is a refinement
    // of it: both arrive as a 4xx, and only the upstream message separates
    // them. The split exists because the recoveries are opposite: a
    // malformed request is terminal, an overflow succeeds once the caller
    // shortens the conversation.
    expect([...PROTOCOL_ERROR_KINDS]).toEqual([
      "rate-limit",
      "auth",
      "overloaded",
      "bad-request",
      "context-overflow",
      "transport",
      "unknown",
    ]);
  });

  it("declares thinking levels in ascending order, off first", () => {
    // Order is load-bearing: clamping picks the nearest supported level by index.
    expect([...THINKING_LEVELS]).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  });
});
