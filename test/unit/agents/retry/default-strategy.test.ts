import { describe, expect, test } from "bun:test";
import { defaultRetryStrategy } from "../../../../src/agents/retry/index";
import type { AdapterFailure } from "../../../../src/context/engine";

const rateLimitFailure: AdapterFailure = {
  category: "availability",
  outcome: "fail-rate-limit",
  retriable: true,
  message: "rate limited",
};

const quotaFailure: AdapterFailure = {
  category: "availability",
  outcome: "fail-quota",
  retriable: false,
  message: "quota exceeded",
};

const ctx = { site: "run" as const, agentName: "claude", stage: "run" as const, storyId: "US-001" };

describe("defaultRetryStrategy", () => {
  test("retries rate-limit failure up to 3 times with exponential backoff", () => {
    expect(defaultRetryStrategy.shouldRetry(rateLimitFailure, 0, ctx)).toEqual({ retry: true, delayMs: 2000 });
    expect(defaultRetryStrategy.shouldRetry(rateLimitFailure, 1, ctx)).toEqual({ retry: true, delayMs: 4000 });
    expect(defaultRetryStrategy.shouldRetry(rateLimitFailure, 2, ctx)).toEqual({ retry: true, delayMs: 8000 });
  });

  test("does not retry on 4th rate-limit attempt (max 3 retries)", () => {
    expect(defaultRetryStrategy.shouldRetry(rateLimitFailure, 3, ctx)).toEqual({ retry: false });
  });

  test("does not retry non-rate-limit failures", () => {
    expect(defaultRetryStrategy.shouldRetry(quotaFailure, 0, ctx)).toEqual({ retry: false });
    expect(defaultRetryStrategy.shouldRetry(new Error("generic"), 0, ctx)).toEqual({ retry: false });
  });

  test("backoff: attempt=0 → 2s, attempt=1 → 4s, attempt=2 → 8s", () => {
    const delays = [0, 1, 2].map((a) => {
      const d = defaultRetryStrategy.shouldRetry(rateLimitFailure, a, ctx);
      return d.retry ? d.delayMs : -1;
    });
    expect(delays).toEqual([2000, 4000, 8000]);
  });
});
