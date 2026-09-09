/**
 * #1960 — the back-fill sees total spend, so a story that burned only
 * failed-dispatch money still gets a metric row.
 */

import { describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import { applyBackfill, hasBackfillEvidence } from "@/execution/lifecycle/backfill-story-metrics";

type BackfillInput = Parameters<typeof applyBackfill>[0];

function baseInput(overrides: Partial<BackfillInput>): BackfillInput {
  return {
    allStoryMetrics: [],
    aggByStory: {},
    stories: [],
    agentFallbacks: new Map(),
    runtimeCrashRetries: new Map(),
    config: makeNaxConfig(),
    defaultAgent: "claude",
    ...overrides,
  };
}

describe("back-fill evidence includes failed-dispatch spend (#1960)", () => {
  test("a story whose only spend threw now has evidence", () => {
    expect(hasBackfillEvidence({ costUsd: 0.004, hopCount: 0, crashCount: 0, story: undefined })).toBe(true);
  });

  test("applyBackfill synthesizes a row for an error-only story", () => {
    const allStoryMetrics: BackfillInput["allStoryMetrics"] = [];
    applyBackfill(
      baseInput({ allStoryMetrics, aggByStory: { "US-009": { totalCostUsd: 0, totalErrorCostUsd: 0.004 } } }),
    );

    expect(allStoryMetrics).toHaveLength(1);
    expect(allStoryMetrics[0].storyId).toBe("US-009");
    expect(allStoryMetrics[0].cost).toBe(0.004);
    expect(allStoryMetrics[0].errorCostUsd).toBe(0.004);
  });

  test("the replacement rule compares total spend, not successful spend", () => {
    const allStoryMetrics: BackfillInput["allStoryMetrics"] = [
      {
        storyId: "US-001",
        complexity: "medium",
        modelTier: "balanced",
        modelUsed: "claude",
        attempts: 1,
        finalTier: "balanced",
        success: true,
        cost: 0.01,
        durationMs: 0,
        firstPassSuccess: true,
        startedAt: "",
        completedAt: "",
      },
    ];
    applyBackfill(
      baseInput({ allStoryMetrics, aggByStory: { "US-001": { totalCostUsd: 0.008, totalErrorCostUsd: 0.005 } } }),
    );

    // 0.013 total spend beats the recorded 0.01, even though successful spend alone (0.008) does not.
    expect(allStoryMetrics[0].cost).toBeCloseTo(0.013, 10);
    expect(allStoryMetrics[0].errorCostUsd).toBe(0.005);
  });

  test("a clean story's metric carries no errorCostUsd field", () => {
    const allStoryMetrics: BackfillInput["allStoryMetrics"] = [];
    applyBackfill(
      baseInput({ allStoryMetrics, aggByStory: { "US-002": { totalCostUsd: 0.02, totalErrorCostUsd: 0 } } }),
    );

    expect("errorCostUsd" in allStoryMetrics[0]).toBe(false);
  });
});
