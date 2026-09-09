/**
 * #1960 — per-story spend reader.
 *
 * `storySpendUsd` is the single seam the story:failed / story:paused /
 * story:completed emitters read through, so the fallback rule and the fold
 * live in exactly one place.
 */

import { describe, expect, test } from "bun:test";
import { CostAggregator, type CostErrorEvent, type CostEvent, storySpendUsd } from "@/runtime/cost-aggregator";

function makeCostEvent(overrides: Partial<CostEvent> = {}): CostEvent {
  return {
    ts: Date.now(),
    runId: "r-001",
    agentName: "claude",
    model: "claude-sonnet-4-6",
    tokens: { input: 100, output: 50 },
    estimatedCostUsd: 0.001,
    exactCostUsd: 0.001,
    costUsd: 0.001,
    confidence: "estimated",
    durationMs: 500,
    ...overrides,
  };
}

function makeErrorEvent(overrides: Partial<CostErrorEvent> = {}): CostErrorEvent {
  return {
    kind: "error",
    ts: Date.now(),
    runId: "r-001",
    agentName: "claude",
    errorCode: "DISPATCH_ERROR",
    durationMs: 50,
    ...overrides,
  };
}

describe("storySpendUsd", () => {
  test("folds failed-dispatch spend into cost and carries it beside", () => {
    const agg = new CostAggregator("r-001", "/tmp/drain");
    agg.record(makeCostEvent({ storyId: "US-001", costUsd: 0.02 }));
    agg.recordError(makeErrorEvent({ storyId: "US-001", costUsd: 0.005 }));

    expect(storySpendUsd(agg, "US-001", 99)).toEqual({ cost: 0.025, errorCostUsd: 0.005 });
  });

  test("an error-only story reports its failed spend, not zero and not the fallback", () => {
    // The regression #1960 exists to close: the error row creates the byStory
    // key, so `?.totalCostUsd ?? fallback` yielded 0 -- worse than the fallback
    // the same story got before failed dispatches were priced.
    const agg = new CostAggregator("r-001", "/tmp/drain");
    agg.recordError(makeErrorEvent({ storyId: "US-002", costUsd: 0.007 }));

    expect(storySpendUsd(agg, "US-002", 42)).toEqual({ cost: 0.007, errorCostUsd: 0.007 });
  });

  test("falls back only when the story has no rows at all", () => {
    const agg = new CostAggregator("r-001", "/tmp/drain");
    agg.record(makeCostEvent({ storyId: "US-001", costUsd: 0.02 }));

    expect(storySpendUsd(agg, "US-404", 1.5)).toEqual({ cost: 1.5, errorCostUsd: 0 });
  });

  test("an unpriced error row leaves cost at the successful spend", () => {
    const agg = new CostAggregator("r-001", "/tmp/drain");
    agg.record(makeCostEvent({ storyId: "US-003", costUsd: 0.01 }));
    agg.recordError(makeErrorEvent({ storyId: "US-003" }));

    expect(storySpendUsd(agg, "US-003", 7)).toEqual({ cost: 0.01, errorCostUsd: 0 });
  });

  test("tolerates an absent aggregator", () => {
    expect(storySpendUsd(undefined, "US-001", 3.25)).toEqual({ cost: 3.25, errorCostUsd: 0 });
  });
});
