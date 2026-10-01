import { describe, expect, test } from "bun:test";
import { defaultRetryStrategy } from "@/agents/retry/index";
import type { AdapterFailure } from "@/context/engine";

const staleFailure: AdapterFailure = {
  category: "availability",
  outcome: "fail-stale",
  retriable: true,
  message: "idle watchdog cancelled prompt due to no stream activity",
};

const staleTerminal: AdapterFailure = {
  category: "availability",
  outcome: "fail-stale",
  retriable: false,
  message: "stale prompt retries exhausted",
};

const rateLimitFailure: AdapterFailure = {
  category: "availability",
  outcome: "fail-rate-limit",
  retriable: true,
  message: "rate limited",
};

const ctx = { site: "run" as const, agentName: "claude", stage: "run" as const, storyId: "US-001" };

describe("fail-stale outcome in AdapterFailure", () => {
  test("fail-stale is a valid AdapterFailure.outcome", () => {
    const failure: AdapterFailure = {
      category: "availability",
      outcome: "fail-stale",
      retriable: true,
      message: "idle watchdog triggered",
    };
    expect(failure.outcome).toBe("fail-stale");
    expect(failure.category).toBe("availability");
  });

  test("fail-stale with retriable=true represents a retryable stale failure", () => {
    expect(staleFailure.retriable).toBe(true);
    expect(staleFailure.category).toBe("availability");
  });

  test("fail-stale with retriable=false represents a terminal stale failure (retries exhausted)", () => {
    expect(staleTerminal.retriable).toBe(false);
    expect(staleTerminal.category).toBe("availability");
  });
});

describe("defaultRetryStrategy with fail-stale", () => {
  test("retries fail-stale on first three attempts like fail-rate-limit", () => {
    const r0 = defaultRetryStrategy.shouldRetry(staleFailure, 0, ctx);
    const r1 = defaultRetryStrategy.shouldRetry(staleFailure, 1, ctx);
    const r2 = defaultRetryStrategy.shouldRetry(staleFailure, 2, ctx);
    expect(r0).toEqual({ retry: true, delayMs: 2000 });
    expect(r1).toEqual({ retry: true, delayMs: 4000 });
    expect(r2).toEqual({ retry: true, delayMs: 8000 });
  });

  test("stops retrying fail-stale on 4th attempt (max 3 retries)", () => {
    const r3 = defaultRetryStrategy.shouldRetry(staleFailure, 3, ctx);
    expect(r3).toEqual({ retry: false });
  });

  test("does not retry fail-stale when retriable=false (retries exhausted)", () => {
    const r0 = defaultRetryStrategy.shouldRetry(staleTerminal, 0, ctx);
    expect(r0).toEqual({ retry: false });
  });

  test("fail-stale and fail-rate-limit follow identical retry backoff", () => {
    const staleDelays = [0, 1, 2].map((a) => {
      const d = defaultRetryStrategy.shouldRetry(staleFailure, a, ctx);
      return d.retry ? d.delayMs : -1;
    });
    const rateLimitDelays = [0, 1, 2].map((a) => {
      const d = defaultRetryStrategy.shouldRetry(rateLimitFailure, a, ctx);
      return d.retry ? d.delayMs : -1;
    });
    expect(staleDelays).toEqual(rateLimitDelays);
  });
});
