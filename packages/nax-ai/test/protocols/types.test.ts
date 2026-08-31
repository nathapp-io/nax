// test/protocols/types.test.ts
import { describe, expect, it } from "vitest";
import { PROTOCOL_ERROR_KINDS, PROTOCOL_EVENT_TYPES, THINKING_LEVELS } from "../../src/protocols/types.ts";

describe("protocol discriminants", () => {
  it("declares exactly the seven event types the spec names", () => {
    expect([...PROTOCOL_EVENT_TYPES]).toEqual([
      "text-delta",
      "thinking-delta",
      "tool-call-partial",
      "tool-call",
      "usage",
      "error",
      "done",
    ]);
  });

  it("declares the six error kinds", () => {
    expect([...PROTOCOL_ERROR_KINDS]).toEqual([
      "rate-limit",
      "auth",
      "overloaded",
      "bad-request",
      "transport",
      "unknown",
    ]);
  });

  it("declares thinking levels in ascending order, off first", () => {
    // Order is load-bearing: clamping picks the nearest supported level by index.
    expect([...THINKING_LEVELS]).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  });
});
