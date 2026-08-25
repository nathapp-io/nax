/**
 * toCostReport — Stable public cost report contract (US-001)
 *
 * AC-1: importable from @/metrics
 * AC-2: schemaVersion equals "1.0"
 * AC-3: generatedAt equals deps.now()
 * AC-4: project equals deps.project
 * AC-5: empty runs → aggregate=null, lastRun=null, modelEfficiency=[]
 * AC-6: aggregate fields equal calculateAggregateMetrics
 * AC-7: lastRun.runId/feature equal getLastRun
 * AC-8: lastRun.stories sorted by cost desc; entries expose exactly storyId/cost/model/attempts
 * AC-9: modelEfficiency sorted by totalCost desc; entries expose exactly model/attempts/passRate/avgCost/totalCost
 * AC-10: lastRun.totalStories=0 → avgCostPerStory===0 (not NaN)
 * AC-11: no internal fields leaked (totalTokens, context, pollution, complexityAccuracy, fallback)
 */

import { describe, expect, test } from "bun:test";
import type { CostReportDeps, CostReportV1, RunMetrics, StoryMetrics } from "@/metrics";
import { calculateAggregateMetrics, getLastRun, toCostReport } from "@/metrics";
import { TokenUsage } from "@/metrics/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStoryMetrics(overrides: Partial<StoryMetrics> & { storyId: string }): StoryMetrics {
  return {
    complexity: "medium",
    modelTier: "balanced",
    modelUsed: "claude-sonnet-4-5",
    attempts: 1,
    finalTier: "balanced",
    success: true,
    cost: 0.1,
    durationMs: 5000,
    firstPassSuccess: true,
    startedAt: "2026-01-01T00:00:00Z",
    completedAt: "2026-01-01T00:00:05Z",
    ...overrides,
  };
}

function makeRun(stories: StoryMetrics[], overrides: Partial<RunMetrics> = {}): RunMetrics {
  return {
    runId: "run-001",
    feature: "test-feature",
    startedAt: "2026-01-01T00:00:00Z",
    completedAt: "2026-01-01T00:01:00Z",
    totalCost: stories.reduce((sum, s) => sum + s.cost, 0),
    totalStories: stories.length,
    storiesCompleted: stories.filter((s) => s.success).length,
    storiesFailed: stories.filter((s) => !s.success).length,
    totalDurationMs: 60000,
    stories,
    ...overrides,
  };
}

const fixedDeps: CostReportDeps = {
  now: () => "2026-01-01T00:00:00.000Z",
  project: "myproj",
};

// ---------------------------------------------------------------------------
// AC-1: importable + safe with empty runs
// ---------------------------------------------------------------------------

describe("toCostReport — module + empty runs safety", () => {
  test("AC1: toCostReport is exported from @/metrics as a function", () => {
    expect(typeof toCostReport).toBe("function");
  });

  test("AC1: toCostReport([], deps) returns an object and does not throw", () => {
    const result = toCostReport([], fixedDeps);
    expect(typeof result).toBe("object");
    expect(result).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC-2/3/4: top-level scalar fields
// ---------------------------------------------------------------------------

describe("toCostReport — schemaVersion / generatedAt / project", () => {
  test("AC2: schemaVersion equals '1.0' regardless of input", () => {
    const result = toCostReport([], fixedDeps);
    expect(result.schemaVersion).toBe("1.0");
  });

  test("AC3: generatedAt equals the ISO string returned by deps.now", () => {
    const deps: CostReportDeps = {
      now: () => "2026-01-01T00:00:00.000Z",
      project: "any",
    };
    const result = toCostReport([], deps);
    expect(result.generatedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  test("AC4: project equals deps.project (e.g. 'myproj')", () => {
    const deps: CostReportDeps = {
      now: () => "2026-01-01T00:00:00.000Z",
      project: "myproj",
    };
    const result = toCostReport([], deps);
    expect(result.project).toBe("myproj");
  });
});

// ---------------------------------------------------------------------------
// AC-5: empty runs → aggregate=null, lastRun=null, modelEfficiency=[]
// ---------------------------------------------------------------------------

describe("toCostReport — empty runs", () => {
  test("AC5: aggregate is null when runs array is empty", () => {
    const result = toCostReport([], fixedDeps);
    expect(result.aggregate).toBeNull();
  });

  test("AC5: lastRun is null when runs array is empty", () => {
    const result = toCostReport([], fixedDeps);
    expect(result.lastRun).toBeNull();
  });

  test("AC5: modelEfficiency deep-equals [] when runs array is empty", () => {
    const result = toCostReport([], fixedDeps);
    expect(result.modelEfficiency).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AC-6: aggregate fields mirror calculateAggregateMetrics
// ---------------------------------------------------------------------------

describe("toCostReport — aggregate mirrors calculateAggregateMetrics", () => {
  test("AC6: aggregate.totalRuns, totalCost, avgCostPerStory equal calculateAggregateMetrics(runs)", () => {
    const stories = [
      makeStoryMetrics({ storyId: "US-001", cost: 0.4 }),
      makeStoryMetrics({ storyId: "US-002", cost: 0.6, modelUsed: "claude-opus-4-5" }),
    ];
    const runs = [makeRun(stories, { runId: "run-a" })];

    const result = toCostReport(runs, fixedDeps);
    const expected = calculateAggregateMetrics(runs);

    expect(result.aggregate).not.toBeNull();
    expect(result.aggregate?.totalRuns).toBe(expected.totalRuns);
    expect(result.aggregate?.totalCost).toBeCloseTo(expected.totalCost, 10);
    expect(result.aggregate?.avgCostPerStory).toBeCloseTo(expected.avgCostPerStory, 10);
  });
});

// ---------------------------------------------------------------------------
// AC-7: lastRun.runId / lastRun.feature mirror getLastRun
// ---------------------------------------------------------------------------

describe("toCostReport — lastRun mirrors getLastRun", () => {
  test("AC7: lastRun.runId and lastRun.feature equal getLastRun(runs)", () => {
    const older = makeRun([makeStoryMetrics({ storyId: "US-OLD" })], {
      runId: "run-old",
      feature: "feat-old",
      startedAt: "2025-12-01T00:00:00Z",
    });
    const newer = makeRun([makeStoryMetrics({ storyId: "US-NEW" })], {
      runId: "run-new",
      feature: "feat-new",
      startedAt: "2026-01-01T00:00:00Z",
    });

    const result = toCostReport([older, newer], fixedDeps);
    const last = getLastRun([older, newer]);

    expect(last).not.toBeNull();
    expect(result.lastRun).not.toBeNull();
    expect(result.lastRun?.runId).toBe(last?.runId);
    expect(result.lastRun?.feature).toBe(last?.feature);
  });
});

// ---------------------------------------------------------------------------
// AC-8: lastRun.stories sorted by cost desc + exact field set
// ---------------------------------------------------------------------------

describe("toCostReport — lastRun.stories ordering + shape", () => {
  test("AC8: lastRun.stories is ordered by cost desc (0.9 then 0.2)", () => {
    const stories = [
      makeStoryMetrics({ storyId: "US-A", cost: 0.2, modelUsed: "claude-haiku-4-5" }),
      makeStoryMetrics({ storyId: "US-B", cost: 0.9, modelUsed: "claude-opus-4-5" }),
    ];
    const runs = [makeRun(stories)];

    const result = toCostReport(runs, fixedDeps);

    expect(result.lastRun).not.toBeNull();
    const costs = result.lastRun?.stories.map((s) => s.cost);
    expect(costs).toEqual([0.9, 0.2]);
  });

  test("AC8: each lastRun.stories entry exposes exactly storyId, cost, model, attempts", () => {
    const stories = [makeStoryMetrics({ storyId: "US-A", cost: 0.3, modelUsed: "claude-opus-4-5", attempts: 2 })];
    const runs = [makeRun(stories)];

    const result = toCostReport(runs, fixedDeps);
    const entry = result.lastRun?.stories[0];

    expect(entry).toBeDefined();
    const keys = Object.keys(entry ?? {}).sort();
    expect(keys).toEqual(["attempts", "cost", "model", "storyId"]);
  });
});

// ---------------------------------------------------------------------------
// AC-9: modelEfficiency ordering + exact field set
// ---------------------------------------------------------------------------

describe("toCostReport — modelEfficiency ordering + shape", () => {
  test("AC9: modelEfficiency sorted by totalCost desc ([3.0, 1.0])", () => {
    const stories = [
      makeStoryMetrics({ storyId: "US-A", cost: 1.0, modelUsed: "model-A" }),
      makeStoryMetrics({ storyId: "US-B", cost: 3.0, modelUsed: "model-B" }),
    ];
    const runs = [makeRun(stories)];

    const result = toCostReport(runs, fixedDeps);

    expect(result.modelEfficiency.length).toBe(2);
    expect(result.modelEfficiency[0].totalCost).toBeCloseTo(3.0, 6);
    expect(result.modelEfficiency[1].totalCost).toBeCloseTo(1.0, 6);
  });

  test("AC9: each modelEfficiency entry exposes exactly model, attempts, passRate, avgCost, totalCost", () => {
    const stories = [makeStoryMetrics({ storyId: "US-A", cost: 0.5, modelUsed: "model-A", attempts: 1 })];
    const runs = [makeRun(stories)];

    const result = toCostReport(runs, fixedDeps);
    const entry = result.modelEfficiency[0];

    expect(entry).toBeDefined();
    const keys = Object.keys(entry).sort();
    expect(keys).toEqual(["attempts", "avgCost", "model", "passRate", "totalCost"]);
  });
});

// ---------------------------------------------------------------------------
// AC-10: avgCostPerStory zero-guard
// ---------------------------------------------------------------------------

describe("toCostReport — avgCostPerStory zero guard", () => {
  test("AC10: when lastRun.totalStories===0, lastRun.avgCostPerStory is 0 and not NaN", () => {
    const emptyRun: RunMetrics = {
      runId: "run-empty",
      feature: "feat-empty",
      startedAt: "2026-01-01T00:00:00Z",
      completedAt: "2026-01-01T00:00:10Z",
      totalCost: 0,
      totalStories: 0,
      storiesCompleted: 0,
      storiesFailed: 0,
      totalDurationMs: 10000,
      stories: [],
    };

    const result = toCostReport([emptyRun], fixedDeps);

    expect(result.lastRun).not.toBeNull();
    expect(result.lastRun?.totalStories).toBe(0);
    const avg = result.lastRun?.avgCostPerStory;
    expect(avg).toBe(0);
    expect(Number.isNaN(avg ?? Number.NaN)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC-11: no internal fields leak
// ---------------------------------------------------------------------------

describe("toCostReport — no internal fields leak", () => {
  test("AC11: aggregate / lastRun / lastRun.stories entries expose none of totalTokens, context, pollution, complexityAccuracy, fallback", () => {
    const stories = [
      makeStoryMetrics({
        storyId: "US-A",
        cost: 0.5,
        modelUsed: "claude-opus-4-5",
        attempts: 2,
        context: {
          providers: {
            tmp: {
              tokensProduced: 1,
              chunksProduced: 1,
              chunksKept: 1,
              wallClockMs: 1,
              timedOut: false,
              failed: false,
            },
          },
          pollution: {
            droppedBelowMinScore: 0,
            staleChunksInjected: 0,
            contradictedChunks: 0,
            ignoredChunks: 0,
            pollutionRatio: 0,
          },
        },
        fallback: { hops: [] },
        tokens: new TokenUsage({ inputTokens: 10, outputTokens: 20 }),
      }),
    ];
    const runs = [
      makeRun(stories, {
        totalTokens: new TokenUsage({ inputTokens: 10, outputTokens: 20 }),
        fallback: {
          totalHops: 0,
          perPair: {},
          exhaustedStories: [],
          totalWastedCostUsd: 0,
        },
      }),
    ];

    const result: CostReportV1 = toCostReport(runs, fixedDeps);

    const forbidden = ["totalTokens", "context", "pollution", "complexityAccuracy", "fallback"];

    const aggregateKeys = result.aggregate ? Object.keys(result.aggregate) : [];
    for (const k of forbidden) {
      expect(aggregateKeys).not.toContain(k);
    }

    const lastRunKeys = result.lastRun ? Object.keys(result.lastRun) : [];
    for (const k of forbidden) {
      expect(lastRunKeys).not.toContain(k);
    }

    for (const story of result.lastRun?.stories ?? []) {
      for (const k of forbidden) {
        expect(Object.keys(story)).not.toContain(k);
      }
    }
  });
});
