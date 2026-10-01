import { describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import { AgentManager } from "@/agents";
import { DEFAULT_CONFIG } from "@/config";
import type { AdapterFailure } from "@/context/engine";

const failTimeoutRetryable: AdapterFailure = {
  category: "quality",
  outcome: "fail-timeout",
  retriable: true,
  message: "wall-clock timeout exceeded",
};

const withFallback = (onQualityFailure: boolean) =>
  makeNaxConfig({
    agent: {
      fallback: {
        enabled: true,
        map: { claude: ["codex"] },
        maxHopsPerStory: 2,
        onQualityFailure,
        rebuildContext: true,
      },
    },
  });

/**
 * nax#1883, superseding nax#1371's US-001 AC10.
 *
 * #1371 made fail-timeout refuse to swap because swapping *was* pruning: the
 * swap branch called markUnavailable and retired the timed-out agent for the
 * rest of the story, so one slow story poisoned the pool. That coupling is
 * gone — fail-timeout's policy cooldown is "none" — so the swap is now safe and
 * the original invariant is asserted directly instead of by proxy.
 */
describe("fail-timeout swaps but never prunes (nax#1883)", () => {
  test("shouldSwap is true once the timeout retry lane is spent", () => {
    expect(new AgentManager(withFallback(false)).shouldSwap(failTimeoutRetryable, 0)).toBe(true);
  });

  test("onQualityFailure does not change the answer in either direction", () => {
    expect(new AgentManager(withFallback(true)).shouldSwap(failTimeoutRetryable, 0)).toBe(true);
    expect(new AgentManager(withFallback(false)).shouldSwap(failTimeoutRetryable, 0)).toBe(true);
  });

  test("still refuses when fallback is disabled entirely", () => {
    expect(new AgentManager(DEFAULT_CONFIG).shouldSwap(failTimeoutRetryable, 0)).toBe(false);
  });

  test("THE #1371 INVARIANT: a timed-out agent is not pruned", () => {
    const manager = new AgentManager(withFallback(false));
    manager.markUnavailable("claude", failTimeoutRetryable);
    expect(manager.isUnavailable("claude")).toBe(false);
  });
});
