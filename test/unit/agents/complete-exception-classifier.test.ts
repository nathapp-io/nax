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
});
