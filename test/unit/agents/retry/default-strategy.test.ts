import { describe, expect, test } from "bun:test";
import { defaultRetryStrategy } from "@/agents/retry/default-strategy";
import type { RetryContext } from "@/agents/retry/types";
import type { AdapterFailure } from "@/context/engine";

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

const nativeCtx: RetryContext = { site: "run", agentName: "native", stage: "run", storyId: "US-001" };

function rateLimit(retryAfterSeconds?: number): AdapterFailure {
  return {
    category: "availability",
    outcome: "fail-rate-limit",
    retriable: true,
    message: "429",
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  };
}

describe("defaultRetryStrategy", () => {
  test("prefers the provider's retryAfterSeconds over computed backoff", () => {
    expect(defaultRetryStrategy.shouldRetry(rateLimit(45), 0, nativeCtx)).toEqual({ retry: true, delayMs: 45_000 });
  });

  test("falls back to exponential backoff when the provider gave none", () => {
    expect(defaultRetryStrategy.shouldRetry(rateLimit(), 0, nativeCtx)).toEqual({ retry: true, delayMs: 2_000 });
    expect(defaultRetryStrategy.shouldRetry(rateLimit(), 1, nativeCtx)).toEqual({ retry: true, delayMs: 4_000 });
  });

  test("falls back to exponential backoff when a provider reports an invalid negative delay", () => {
    expect(defaultRetryStrategy.shouldRetry(rateLimit(-1), 0, nativeCtx)).toEqual({ retry: true, delayMs: 2_000 });
  });

  test("the provider's delay does not extend the attempt budget", () => {
    expect(defaultRetryStrategy.shouldRetry(rateLimit(45), 3, nativeCtx)).toEqual({ retry: false });
  });

  test("still declines outcomes it never accepted", () => {
    const quality: AdapterFailure = {
      category: "quality",
      outcome: "fail-quality",
      retriable: true,
      message: "x",
      retryAfterSeconds: 45,
    };
    expect(defaultRetryStrategy.shouldRetry(quality, 0, nativeCtx)).toEqual({ retry: false });
  });

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

describe("defaultRetryStrategy follows the policy table", () => {
  const ctx = { site: "run", agentName: "claude", stage: "run", storyId: "us-001" } as const;

  const failure = (outcome: AdapterFailure["outcome"]): AdapterFailure => ({
    category: "availability",
    outcome,
    retriable: true,
    message: "",
  });

  test("retries fail-service-down, which it used to decline", () => {
    expect(defaultRetryStrategy.shouldRetry(failure("fail-service-down"), 0, ctx)).toEqual({
      retry: true,
      delayMs: 2_000,
    });
  });

  test("still declines a quality failure", () => {
    expect(defaultRetryStrategy.shouldRetry(failure("fail-quality"), 0, ctx)).toEqual({ retry: false });
  });

  test("still honours the provider's retryAfterSeconds over the computed backoff", () => {
    const withRetryAfter = { ...failure("fail-rate-limit"), retryAfterSeconds: 45 };
    expect(defaultRetryStrategy.shouldRetry(withRetryAfter, 0, ctx)).toEqual({ retry: true, delayMs: 45_000 });
  });
});
