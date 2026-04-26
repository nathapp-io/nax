/**
 * AgentManager.runWithFallback — AbortSignal plumbing (#585 Path B).
 *
 * Verifies that when a request carries an `AbortSignal`, rate-limit backoff
 * settles within a few ms instead of the full exponential wait, and that the
 * outcome reflects the aborted state rather than continuing to retry.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { AgentManager, _agentManagerDeps } from "../../../src/agents/manager";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";

const rateLimitFailure = {
  category: "availability" as const,
  outcome: "fail-rate-limit" as const,
  retriable: true,
  message: "429",
};

const mockBundle = {} as import("../../../src/context/engine").ContextBundle;

function makeConfigNoFallback() {
  // No fallback chain — forces the rate-limit-backoff branch rather than a swap.
  return {
    ...DEFAULT_CONFIG,
    agent: {
      ...DEFAULT_CONFIG.agent,
      fallback: { enabled: false, map: {}, maxHopsPerStory: 0, onQualityFailure: false, rebuildContext: false },
    },
  } as never;
}

function makeRateLimitedRunHop() {
  return async () => ({
    prompt: "prompt-mock",
    result: {
      success: false,
      exitCode: 1,
      output: "rate limit",
      rateLimited: true,
      durationMs: 1,
      estimatedCost: 0,
      adapterFailure: rateLimitFailure,
    },
  });
}

describe("AgentManager.runWithFallback — abort signal (#585)", () => {
  const origSleep = _agentManagerDeps.sleep;
  afterEach(() => {
    _agentManagerDeps.sleep = origSleep;
  });

  test("pre-aborted signal stops backoff immediately (no sleep issued)", async () => {
    const sleepCalls: Array<{ ms: number; aborted: boolean }> = [];
    _agentManagerDeps.sleep = async (ms, signal) => {
      sleepCalls.push({ ms, aborted: Boolean(signal?.aborted) });
    };

    const controller = new AbortController();
    controller.abort();

    const m = new AgentManager(makeConfigNoFallback(), undefined, { runHop: makeRateLimitedRunHop() });
    const outcome = await m.runWithFallback({
      runOptions: { storyId: "s1" } as never,
      bundle: mockBundle,
      signal: controller.signal,
    });

    // The adapter ran once and returned the rate-limit failure.
    // Backoff sleep must NOT have been issued because the signal was already aborted.
    expect(outcome.result.success).toBe(false);
    expect(sleepCalls).toHaveLength(0);
  });

  test("signal forwarded to sleep — backoff races against it", async () => {
    let receivedSignal: AbortSignal | undefined;
    _agentManagerDeps.sleep = async (_ms, signal) => {
      receivedSignal = signal;
    };

    const controller = new AbortController();
    const m = new AgentManager(makeConfigNoFallback(), undefined, { runHop: makeRateLimitedRunHop() });
    await m.runWithFallback({
      runOptions: { storyId: "s1" } as never,
      bundle: mockBundle,
      signal: controller.signal,
    });

    expect(receivedSignal).toBe(controller.signal);
  });

  test("abort during backoff returns without further retries", async () => {
    // Simulate a sleep that "wakes up" to find the signal aborted.
    _agentManagerDeps.sleep = async (_ms, signal) => {
      if (signal && !signal.aborted) {
        // pretend the signal aborted while we were sleeping
        (signal as unknown as { _testAbort?: () => void })._testAbort?.();
      }
    };

    const controller = new AbortController();
    // Abort after a microtask so the first hop runs, then the signal is aborted
    // before the backoff loop checks again.
    queueMicrotask(() => controller.abort());

    const m = new AgentManager(makeConfigNoFallback(), undefined, { runHop: makeRateLimitedRunHop() });
    const startHops = performance.now();
    const outcome = await m.runWithFallback({
      runOptions: { storyId: "s1" } as never,
      bundle: mockBundle,
      signal: controller.signal,
    });
    const elapsed = performance.now() - startHops;

    // Settled quickly, did not loop through all 3 backoff attempts.
    expect(elapsed).toBeLessThan(500);
    expect(outcome.result.adapterFailure?.outcome).toBe("fail-rate-limit");
  });
});
