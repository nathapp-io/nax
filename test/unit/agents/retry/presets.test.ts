import { describe, expect, test } from "bun:test";
import { resolveRetryPreset } from "../../../../src/agents/retry";
import type { RetryPreset } from "../../../../src/agents/retry";

const ctx = { site: "complete" as const, agentName: "claude", stage: "run" as const };
const preset: RetryPreset = { preset: "transient-network", maxAttempts: 2, baseDelayMs: 1000 };

describe("resolveRetryPreset", () => {
  test("retries on thrown Error when attempt < maxAttempts-1", () => {
    const strategy = resolveRetryPreset(preset);
    expect(strategy.shouldRetry(new Error("timeout"), 0, ctx)).toEqual({ retry: true, delayMs: 1000 });
  });

  test("stops after maxAttempts-1 retries", () => {
    const strategy = resolveRetryPreset(preset);
    // maxAttempts=2 → only 1 retry allowed (attempt 0). attempt 1 → stop.
    expect(strategy.shouldRetry(new Error("timeout"), 1, ctx)).toEqual({ retry: false });
  });

  test("retries on retriable AdapterFailure", () => {
    const strategy = resolveRetryPreset(preset);
    const af = { category: "availability" as const, outcome: "fail-rate-limit" as const, retriable: true, message: "" };
    expect(strategy.shouldRetry(af, 0, ctx)).toEqual({ retry: true, delayMs: 1000 });
  });

  test("does not retry non-retriable AdapterFailure", () => {
    const strategy = resolveRetryPreset(preset);
    const af = { category: "availability" as const, outcome: "fail-auth" as const, retriable: false, message: "" };
    expect(strategy.shouldRetry(af, 0, ctx)).toEqual({ retry: false });
  });

  test("maxAttempts: 3 allows 2 retries", () => {
    const s = resolveRetryPreset({ preset: "transient-network", maxAttempts: 3, baseDelayMs: 500 });
    expect(s.shouldRetry(new Error("x"), 0, ctx)).toEqual({ retry: true, delayMs: 500 });
    expect(s.shouldRetry(new Error("x"), 1, ctx)).toEqual({ retry: true, delayMs: 500 });
    expect(s.shouldRetry(new Error("x"), 2, ctx)).toEqual({ retry: false });
  });
});
