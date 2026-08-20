import { describe, expect, test } from "bun:test";
import { composeRetry } from "@/agents/retry/index";
import type { RetryContext, RetryDecision, RetryStrategy } from "@/agents/retry/index";

const ctx: RetryContext = { site: "run" as const, agentName: "claude", stage: "run" as const, storyId: "US-001" };
const testErr = new Error("test error");

describe("composeRetry", () => {
  test("empty array returns strategy that never retries", () => {
    const composed = composeRetry([]);
    expect(composed.shouldRetry(testErr, 0, ctx)).toEqual({ retry: false });
    expect(composed.shouldRetry(testErr, 5, ctx)).toEqual({ retry: false });
  });

  test("first strategy match wins and later strategies are not consulted", () => {
    let s1Called = false;
    const s0: RetryStrategy = {
      shouldRetry(): RetryDecision {
        return { retry: true, delayMs: 100, nextPrompt: "p" };
      },
    };
    const s1: RetryStrategy = {
      shouldRetry(): RetryDecision {
        s1Called = true;
        return { retry: true, delayMs: 50 };
      },
    };

    const composed = composeRetry([s0, s1]);
    const result = composed.shouldRetry(testErr, 0, ctx);
    expect(result).toEqual({ retry: true, delayMs: 100, nextPrompt: "p" });
    expect(s1Called).toBe(false);
  });

  test("when first returns false, second is consulted and wins", () => {
    const s0: RetryStrategy = {
      shouldRetry(): RetryDecision {
        return { retry: false };
      },
    };
    const s1: RetryStrategy = {
      shouldRetry(): RetryDecision {
        return { retry: true, delayMs: 50 };
      },
    };

    const composed = composeRetry([s0, s1]);
    const result = composed.shouldRetry(testErr, 0, ctx);
    expect(result).toEqual({ retry: true, delayMs: 50 });
  });

  test("all strategies returning false results in no retry", () => {
    const s0: RetryStrategy = {
      shouldRetry(): RetryDecision {
        return { retry: false };
      },
    };
    const s1: RetryStrategy = {
      shouldRetry(): RetryDecision {
        return { retry: false };
      },
    };

    const composed = composeRetry([s0, s1]);
    const result = composed.shouldRetry(testErr, 0, ctx);
    expect(result).toEqual({ retry: false });
  });

  test("strategies are consulted in order until first match", () => {
    let callOrder: number[] = [];
    const s0: RetryStrategy = {
      shouldRetry(): RetryDecision {
        callOrder.push(0);
        return { retry: false };
      },
    };
    const s1: RetryStrategy = {
      shouldRetry(): RetryDecision {
        callOrder.push(1);
        return { retry: false };
      },
    };
    const s2: RetryStrategy = {
      shouldRetry(): RetryDecision {
        callOrder.push(2);
        return { retry: true, delayMs: 25 };
      },
    };

    const composed = composeRetry([s0, s1, s2]);
    const result = composed.shouldRetry(testErr, 0, ctx);
    expect(callOrder).toEqual([0, 1, 2]);
    expect(result).toEqual({ retry: true, delayMs: 25 });
  });

  test("stops consulting after first retry=true decision", () => {
    let callOrder: number[] = [];
    const s0: RetryStrategy = {
      shouldRetry(): RetryDecision {
        callOrder.push(0);
        return { retry: false };
      },
    };
    const s1: RetryStrategy = {
      shouldRetry(): RetryDecision {
        callOrder.push(1);
        return { retry: true, delayMs: 75 };
      },
    };
    const s2: RetryStrategy = {
      shouldRetry(): RetryDecision {
        callOrder.push(2);
        throw new Error("should not be called");
      },
    };

    const composed = composeRetry([s0, s1, s2]);
    const result = composed.shouldRetry(testErr, 0, ctx);
    expect(callOrder).toEqual([0, 1]);
    expect(result).toEqual({ retry: true, delayMs: 75 });
  });

  test("passes failure, attempt, and context through to each strategy", () => {
    let receivedArgs: [any, number, RetryContext][] = [];
    const s0: RetryStrategy = {
      shouldRetry(failure, attempt, c): RetryDecision {
        receivedArgs.push([failure, attempt, c]);
        return { retry: false };
      },
    };

    const composed = composeRetry([s0]);
    composed.shouldRetry(testErr, 3, ctx);
    expect(receivedArgs).toEqual([[testErr, 3, ctx]]);
  });

  test("single strategy in array works correctly", () => {
    const s0: RetryStrategy = {
      shouldRetry(): RetryDecision {
        return { retry: true, delayMs: 200 };
      },
    };

    const composed = composeRetry([s0]);
    expect(composed.shouldRetry(testErr, 0, ctx)).toEqual({ retry: true, delayMs: 200 });
  });
});
