/**
 * #1960 — the invariant this issue exists to protect.
 *
 * Measured on 2026-09-09: the last 93 consecutive recorded runs satisfy
 * `totalCost == sum(stories[].cost)` to the cent. This test is what keeps
 * that true once failed dispatches carry usage.
 */

import { describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import { applyBackfill } from "@/execution/lifecycle/backfill-story-metrics";
import { CostAggregator, totalSpendUsd } from "@/runtime/cost-aggregator";

describe("run metrics reconcile (#1960)", () => {
  test("sum(stories[].cost) equals the run total when dispatches threw with billed usage", () => {
    const agg = new CostAggregator("r-001", "/tmp/drain");
    // US-001 succeeded; US-002 burned only failed spend.
    agg.record({
      ts: Date.now(),
      runId: "r-001",
      agentName: "claude",
      model: "m",
      tokens: { input: 10, output: 5 },
      estimatedCostUsd: 0.02,
      exactCostUsd: 0.02,
      costUsd: 0.02,
      confidence: "estimated",
      durationMs: 10,
      storyId: "US-001",
    });
    agg.recordError({
      kind: "error",
      ts: Date.now(),
      runId: "r-001",
      agentName: "claude",
      errorCode: "DISPATCH_ERROR",
      durationMs: 5,
      storyId: "US-002",
      costUsd: 0.004,
    });

    type BackfillInput = Parameters<typeof applyBackfill>[0];
    const allStoryMetrics: BackfillInput["allStoryMetrics"] = [];
    applyBackfill({
      allStoryMetrics,
      aggByStory: agg.byStory(),
      stories: [],
      agentFallbacks: new Map(),
      runtimeCrashRetries: new Map(),
      config: makeNaxConfig(),
      defaultAgent: "claude",
    });

    const runTotal = totalSpendUsd(agg.snapshot());
    const storySum = allStoryMetrics.reduce((sum, m) => sum + m.cost, 0);

    expect(runTotal).toBeCloseTo(0.024, 10);
    expect(storySum).toBeCloseTo(runTotal, 10);
  });
});
