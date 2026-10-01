/**
 * computeBandStats — US-002 pure band-stat computation
 *
 * AC-1: 10 "simple" stories, 4 with attempts > 1 -> sampleCount=10, escalationRate=0.4
 * AC-2: 9 of 10 "simple" stories have firstPassSuccess=true -> firstPassRate=0.9
 * AC-3: mapping simple->"fast", 3/10 finalTier==="balanced" -> mismatchRate=0.3
 * AC-4: only BandStats for complexity values actually present in history
 * AC-5: empty runs -> empty BandStat[]
 */

import { describe, expect, test } from "bun:test";
import type { Complexity, ModelTier } from "@/config/schema-types";
import type { RunMetrics, StoryMetrics } from "@/metrics/types";
import type {
  BandStat,
  CalibrationProposal,
  CalibrationThresholds,
  KeywordHint,
  SkippedBand,
  TierAdjustment,
} from "@/routing";
import { computeBandStats } from "@/routing";

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
    cost: 0.01,
    durationMs: 5000,
    firstPassSuccess: true,
    startedAt: "2026-01-01T00:00:00Z",
    completedAt: "2026-01-01T00:00:05Z",
    ...overrides,
  };
}

function makeRun(stories: StoryMetrics[]): RunMetrics {
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
  };
}

const mapping: Record<Complexity, ModelTier> = {
  simple: "fast",
  medium: "balanced",
  complex: "powerful",
  expert: "powerful",
};

// ---------------------------------------------------------------------------
// AC-1: sampleCount + escalationRate from attempts > 1
// ---------------------------------------------------------------------------

describe("computeBandStats - sampleCount + escalationRate", () => {
  test("AC-1: 10 'simple' stories with 4 escalated -> sampleCount=10, escalationRate=0.4", () => {
    const stories: StoryMetrics[] = [];
    for (let i = 1; i <= 10; i++) {
      stories.push(
        makeStoryMetrics({
          storyId: `US-${String(i).padStart(3, "0")}`,
          complexity: "simple",
          initialComplexity: "simple",
          modelTier: "fast",
          finalTier: "fast",
          attempts: i <= 4 ? 2 : 1, // first 4 escalated
          firstPassSuccess: i > 4,
        }),
      );
    }
    const runs = [makeRun(stories)];

    const bands = computeBandStats(runs, mapping);
    const simple = bands.find((b) => b.complexity === "simple");

    expect(simple).toBeDefined();
    expect(simple?.sampleCount).toBe(10);
    expect(simple?.escalationRate).toBe(0.4);
  });
});

// ---------------------------------------------------------------------------
// AC-2: firstPassRate
// ---------------------------------------------------------------------------

describe("computeBandStats - firstPassRate", () => {
  test("AC-2: 9 of 10 'simple' stories with firstPassSuccess=true -> firstPassRate=0.9", () => {
    const stories: StoryMetrics[] = [];
    for (let i = 1; i <= 10; i++) {
      stories.push(
        makeStoryMetrics({
          storyId: `US-${String(i).padStart(3, "0")}`,
          complexity: "simple",
          initialComplexity: "simple",
          modelTier: "fast",
          finalTier: "fast",
          firstPassSuccess: i <= 9, // first 9 succeed first pass
        }),
      );
    }
    const runs = [makeRun(stories)];

    const bands = computeBandStats(runs, mapping);
    const simple = bands.find((b) => b.complexity === "simple");

    expect(simple).toBeDefined();
    expect(simple?.firstPassRate).toBe(0.9);
  });
});

// ---------------------------------------------------------------------------
// AC-3: mismatchRate (finalTier !== mapped tier from complexity)
// ---------------------------------------------------------------------------

describe("computeBandStats - mismatchRate", () => {
  test("AC-3: mapping simple->'fast', 3/10 finalTier='balanced' -> mismatchRate=0.3", () => {
    const stories: StoryMetrics[] = [];
    for (let i = 1; i <= 10; i++) {
      stories.push(
        makeStoryMetrics({
          storyId: `US-${String(i).padStart(3, "0")}`,
          complexity: "simple",
          initialComplexity: "simple",
          modelTier: "fast",
          finalTier: i <= 3 ? "balanced" : "fast", // first 3 escalated to balanced
        }),
      );
    }
    const runs = [makeRun(stories)];

    const bands = computeBandStats(runs, mapping);
    const simple = bands.find((b) => b.complexity === "simple");

    expect(simple).toBeDefined();
    expect(simple?.mismatchRate).toBe(0.3);
  });
});

// ---------------------------------------------------------------------------
// AC-4: BandStat per distinct complexity present in history
// ---------------------------------------------------------------------------

describe("computeBandStats - distinct complexity values", () => {
  test("AC-4: returns one BandStat per distinct complexity present in history (and none for absent complexities)", () => {
    const stories = [
      makeStoryMetrics({ storyId: "US-001", complexity: "simple", initialComplexity: "simple", finalTier: "fast" }),
      makeStoryMetrics({ storyId: "US-002", complexity: "simple", initialComplexity: "simple", finalTier: "fast" }),
      makeStoryMetrics({ storyId: "US-003", complexity: "medium", initialComplexity: "medium", finalTier: "balanced" }),
    ];
    const runs = [makeRun(stories)];

    const bands = computeBandStats(runs, mapping);

    expect(bands.length).toBe(2);
    expect(bands.find((b) => b.complexity === "simple")).toBeDefined();
    expect(bands.find((b) => b.complexity === "medium")).toBeDefined();
    expect(bands.find((b) => b.complexity === "complex")).toBeUndefined();
    expect(bands.find((b) => b.complexity === "expert")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC-5: empty runs -> empty array
// ---------------------------------------------------------------------------

describe("computeBandStats - empty history", () => {
  test("AC-5: empty RunMetrics[] -> empty BandStat[]", () => {
    const bands = computeBandStats([], mapping);
    expect(bands).toEqual([]);
  });

  test("AC-5b: runs with no stories -> empty BandStat[]", () => {
    const runs: RunMetrics[] = [makeRun([])];
    const bands = computeBandStats(runs, mapping);
    expect(bands).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Regression guards: cross-run flattening + public-type surface
// (Adversarial review #2/#3 — not covered by ACs but required for the
//  library to fulfill its stated purpose.)
// ---------------------------------------------------------------------------

describe("computeBandStats - cross-run flattening", () => {
  test("merges same-band stories across multiple runs into one BandStat", () => {
    const runAStories = [
      makeStoryMetrics({
        storyId: "US-A1",
        complexity: "simple",
        initialComplexity: "simple",
        finalTier: "fast",
        attempts: 2,
        firstPassSuccess: false,
      }),
      makeStoryMetrics({ storyId: "US-A2", complexity: "simple", initialComplexity: "simple", finalTier: "fast" }),
    ];
    const runBStories = [
      makeStoryMetrics({ storyId: "US-B1", complexity: "simple", initialComplexity: "simple", finalTier: "fast" }),
      makeStoryMetrics({ storyId: "US-B2", complexity: "simple", initialComplexity: "simple", finalTier: "fast" }),
    ];
    const runs = [makeRun(runAStories), { ...makeRun(runBStories), runId: "run-002" }];

    const bands = computeBandStats(runs, mapping);
    const simple = bands.find((b) => b.complexity === "simple");

    expect(simple?.sampleCount).toBe(4);
    expect(simple?.escalationRate).toBe(0.25); // 1 of 4 escalated (US-A1)
  });

  test("preserves empty runs in the middle of the runs array", () => {
    const stories = [
      makeStoryMetrics({ storyId: "US-001", complexity: "simple", initialComplexity: "simple", finalTier: "fast" }),
      makeStoryMetrics({ storyId: "US-002", complexity: "simple", initialComplexity: "simple", finalTier: "fast" }),
    ];
    const runs: RunMetrics[] = [makeRun([]), makeRun(stories), makeRun([])];

    const bands = computeBandStats(runs, mapping);
    const simple = bands.find((b) => b.complexity === "simple");

    expect(simple?.sampleCount).toBe(2);
  });
});

describe("@/routing barrel - calibration public type surface", () => {
  test("re-exports all calibration types (compile-time surface guard)", () => {
    // Type-only references preserve the public barrel contract: removing
    // any of these from `src/routing/index.ts` would break the imports
    // below at compile time.
    type _Surface = {
      computeBandStats: typeof computeBandStats;
      BandStat: BandStat;
      TierAdjustment: TierAdjustment;
      KeywordHint: KeywordHint;
      SkippedBand: SkippedBand;
      CalibrationProposal: CalibrationProposal;
      CalibrationThresholds: CalibrationThresholds;
    };
    const _: _Surface | undefined = undefined;
    expect(_).toBeUndefined();
  });

  test("runtime-exports computeBandStats (the only value export)", async () => {
    const surface = await import("@/routing");
    expect(typeof surface.computeBandStats).toBe("function");
  });
});
