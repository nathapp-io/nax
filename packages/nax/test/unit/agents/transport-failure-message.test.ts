import { describe, expect, test } from "bun:test";
import { classifyCompleteException } from "@/agents";
import { decideSwap } from "@/agents/swap-decision";
import { isTransportFailureMessage } from "@/agents/transport-failure-message";

// nax#1869. parseAgentError matches structured signals only, by design. What
// reaches this table is the free text left over when a provider reports a
// transport fault with no machine-readable envelope -- the class of failure a
// swap or a backoff can actually recover, and which was indistinguishable from
// a genuinely unknown failure before.
describe("isTransportFailureMessage", () => {
  test.each([
    ["openrouter stall", "Upstream idle timeout exceeded"],
    ["stream idle", "stream idle timeout"],
    ["bad gateway", "502 Bad Gateway"],
    ["service unavailable", "503 Service Unavailable"],
    ["gateway timeout", "504 Gateway Timeout"],
    ["connection reset", "read ECONNRESET"],
    ["socket hang up", "socket hang up"],
    ["connection refused", "connect ECONNREFUSED 127.0.0.1:443"],
    ["premature close", "Premature close"],
    ["terminated", "terminated: other side closed"],
    ["fetch network error", "Network error: fetch failed"],
  ])("recognises %s", (_label, message) => {
    expect(isTransportFailureMessage(message)).toBe(true);
  });

  test("matches regardless of case, because providers do not agree on it", () => {
    expect(isTransportFailureMessage("UPSTREAM IDLE TIMEOUT EXCEEDED")).toBe(true);
  });

  test.each([
    ["a genuine unknown", "something unexpected exploded"],
    ["our own bug", "undefined is not a function"],
    ["a refusal", "I cannot help with that request"],
    ["empty", ""],
  ])("does not claim %s", (_label, message) => {
    expect(isTransportFailureMessage(message)).toBe(false);
  });

  // The words appear, but as prose the model wrote rather than as a fault
  // report. A blocklist of bare words would take these; the phrases must stay
  // specific enough not to.
  test("does not fire on ordinary prose that mentions the concepts", () => {
    expect(isTransportFailureMessage("The gateway pattern is described in the timeout section.")).toBe(false);
  });

  // Statuses are matched by their words, never their digits: these numbers are
  // a cost, a token count and a line reference.
  test("does not fire on a bare status-shaped number", () => {
    expect(isTransportFailureMessage("estimated cost 502 units")).toBe(false);
    expect(isTransportFailureMessage("503 tokens remaining in the window")).toBe(false);
    expect(isTransportFailureMessage("assertion failed at line 504")).toBe(false);
  });
});

describe("classifyCompleteException on an unstructured transport fault", () => {
  test("classifies a provider stall as retriable availability/fail-service-down", () => {
    const failure = classifyCompleteException(new Error("Upstream idle timeout exceeded"));
    expect(failure).toEqual({
      category: "availability",
      outcome: "fail-service-down",
      retriable: true,
      message: "Upstream idle timeout exceeded",
    });
  });

  test("leaves a genuinely unclassifiable error on quality/fail-unknown", () => {
    const failure = classifyCompleteException(new Error("something unexpected exploded"));
    expect(failure.category).toBe("quality");
    expect(failure.outcome).toBe("fail-unknown");
  });

  test("reads the full message, not the truncated one", () => {
    // The marker sits past the 500-char truncation point. Classifying on the
    // slice would miss it, exactly as it would miss a long JSON envelope.
    const err = new Error(`${"x".repeat(600)} Upstream idle timeout exceeded`);
    expect(classifyCompleteException(err).outcome).toBe("fail-service-down");
  });

  // The gate the bug was actually lost at. A classification that does not
  // reach {swap: true} would fix nothing -- fail-timeout, for instance, is
  // refused outright by decideSwap's first gate.
  test("the resulting failure passes decideSwap, where the old one was declined", () => {
    const stall = classifyCompleteException(new Error("Upstream idle timeout exceeded"));
    const fallback = { enabled: true, maxHopsPerStory: 2 };
    expect(decideSwap(stall, 0, fallback)).toEqual({ swap: true });

    const unknown = classifyCompleteException(new Error("something unexpected exploded"));
    expect(decideSwap(unknown, 0, fallback)).toEqual({ swap: false, reason: "quality-failure-declined" });
  });
});
