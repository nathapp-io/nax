import { describe, expect, test } from "bun:test";
import { classifyCompleteException } from "@/agents";
import { NaxError } from "@/errors";

describe("classifyCompleteException", () => {
  test("classifies AGENT_TIMEOUT as a retriable quality/fail-timeout failure", () => {
    const err = new NaxError("complete() timed out", "AGENT_TIMEOUT", { stage: "acp", timeoutMs: 1000 });
    const failure = classifyCompleteException(err);
    expect(failure).toEqual({
      category: "quality",
      outcome: "fail-timeout",
      retriable: true,
      message: "complete() timed out",
    });
  });

  test("classifies a structured rate-limit error message as availability/fail-rate-limit", () => {
    const err = new Error(JSON.stringify({ type: "rate-limit", retryAfterSeconds: 30 }));
    const failure = classifyCompleteException(err);
    expect(failure.category).toBe("availability");
    expect(failure.outcome).toBe("fail-rate-limit");
    expect(failure.retriable).toBe(true);
    expect(failure.retryAfterSeconds).toBe(30);
  });

  test("classifies a structured auth error message as availability/fail-auth, non-retriable", () => {
    const err = new Error(JSON.stringify({ type: "auth" }));
    const failure = classifyCompleteException(err);
    expect(failure).toEqual({
      category: "availability",
      outcome: "fail-auth",
      retriable: false,
      message: JSON.stringify({ type: "auth" }),
    });
  });

  test("classifies a model-not-available error message as quality/fail-adapter-error, non-retriable", () => {
    const err = new Error('Cannot apply --model "bogus": the ACP agent did not advertise that model.');
    const failure = classifyCompleteException(err);
    expect(failure.category).toBe("quality");
    expect(failure.outcome).toBe("fail-adapter-error");
    expect(failure.retriable).toBe(false);
  });

  test("falls back to quality/fail-unknown, non-retriable, for an unclassifiable error", () => {
    const err = new Error("something unexpected exploded");
    const failure = classifyCompleteException(err);
    expect(failure).toEqual({
      category: "quality",
      outcome: "fail-unknown",
      retriable: false,
      message: "something unexpected exploded",
    });
  });

  test("handles non-Error thrown values", () => {
    const failure = classifyCompleteException("a bare string throw");
    expect(failure.message).toBe("a bare string throw");
    expect(failure.outcome).toBe("fail-unknown");
  });

  test("truncates the message to 500 chars", () => {
    const err = new Error("x".repeat(600));
    const failure = classifyCompleteException(err);
    expect(failure.message.length).toBe(500);
  });

  test("classifies a structured timeout error message as retriable quality/fail-timeout", () => {
    const err = new Error(JSON.stringify({ type: "timeout" }));
    const failure = classifyCompleteException(err);
    expect(failure).toEqual({
      category: "quality",
      outcome: "fail-timeout",
      retriable: true,
      message: JSON.stringify({ type: "timeout" }),
    });
  });

  test("classifies a structured crash error message as non-retriable quality/fail-adapter-error", () => {
    const err = new Error(JSON.stringify({ type: "crash" }));
    const failure = classifyCompleteException(err);
    expect(failure).toEqual({
      category: "quality",
      outcome: "fail-adapter-error",
      retriable: false,
      message: JSON.stringify({ type: "crash" }),
    });
  });

  test("classifies correctly even when the structured error exceeds the 500-char truncation length", () => {
    // parseAgentError must run against the FULL message, not the truncated one —
    // a structured JSON payload over 500 chars would otherwise fail JSON.parse
    // on the sliced fragment and silently degrade to fail-unknown.
    const padding = "x".repeat(480);
    const err = new Error(JSON.stringify({ type: "rate-limit", retryAfterSeconds: 12, padding }));
    expect(err.message.length).toBeGreaterThan(500);
    const failure = classifyCompleteException(err);
    expect(failure.category).toBe("availability");
    expect(failure.outcome).toBe("fail-rate-limit");
    expect(failure.retriable).toBe(true);
    expect(failure.retryAfterSeconds).toBe(12);
    expect(failure.message.length).toBe(500);
  });
});
