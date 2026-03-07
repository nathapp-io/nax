/**
 * Metrics Aggregator — RRP-002: complexityAccuracy uses initialComplexity
 *
 * AC-6: calculateAggregateMetrics complexityAccuracy compares
 *       initialComplexity (predicted) vs finalTier (actual), not
 *       complexity (which may reflect post-escalation state).
 */

import { describe, expect, test } from "bun:test";
import { calculateAggregateMetrics } from "../../../src/metrics/aggregator";
import type { RunMetrics, StoryMetrics } from "../../../src/metrics/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStoryMetrics(overrides: Partial<StoryMetrics> & { storyId: string }): StoryMetrics {
  return {
    storyId: overrides.storyId,
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

// ---------------------------------------------------------------------------
// AC-6: complexityAccuracy uses initialComplexity as predicted complexity
// ---------------------------------------------------------------------------

describe("calculateAggregateMetrics - complexityAccuracy uses initialComplexity", () => {
  test("complexityAccuracy keyed by initialComplexity when present", () => {
    // Story originally predicted as 'simple' but escalated (finalTier = 'powerful')
    const story = makeStoryMetrics({
      storyId: "US-001",
      complexity: "medium",          // post-escalation complexity
      initialComplexity: "simple",   // original prediction
      modelTier: "fast",
      finalTier: "powerful",
      attempts: 2,
      firstPassSuccess: false,
    });

    const runs = [makeRun([story])];
    const aggregate = calculateAggregateMetrics(runs);

    // complexityAccuracy should be keyed by initialComplexity ("simple"), not complexity ("medium")
    expect(aggregate.complexityAccuracy["simple"]).toBeDefined();
    expect(aggregate.complexityAccuracy["medium"]).toBeUndefined();
  });

  test("mismatch detected when initialComplexity tier != finalTier", () => {
    const escalatedStory = makeStoryMetrics({
      storyId: "US-001",
      complexity: "medium",
      initialComplexity: "simple",
      modelTier: "fast",
      finalTier: "powerful",
      attempts: 2,
      firstPassSuccess: false,
    });

    const runs = [makeRun([escalatedStory])];
    const aggregate = calculateAggregateMetrics(runs);

    // simple -> powerful: mismatch expected
    expect(aggregate.complexityAccuracy["simple"].mismatchRate).toBeGreaterThan(0);
  });

  test("no mismatch when initialComplexity tier matches finalTier", () => {
    const successStory = makeStoryMetrics({
      storyId: "US-001",
      complexity: "medium",
      initialComplexity: "medium",
      modelTier: "balanced",
      finalTier: "balanced",
      attempts: 1,
      firstPassSuccess: true,
    });

    const runs = [makeRun([successStory])];
    const aggregate = calculateAggregateMetrics(runs);

    expect(aggregate.complexityAccuracy["medium"].mismatchRate).toBe(0);
  });

  test("falls back to complexity when initialComplexity is absent (backward compat)", () => {
    // Legacy story metrics without initialComplexity
    const legacyStory = makeStoryMetrics({
      storyId: "US-001",
      complexity: "complex",
      // no initialComplexity
      modelTier: "powerful",
      finalTier: "powerful",
    });

    const runs = [makeRun([legacyStory])];
    const aggregate = calculateAggregateMetrics(runs);

    // Falls back to complexity as key
    expect(aggregate.complexityAccuracy["complex"]).toBeDefined();
  });

  test("mixes initialComplexity-keyed and legacy entries correctly", () => {
    const modernStory = makeStoryMetrics({
      storyId: "US-001",
      complexity: "medium",
      initialComplexity: "simple",
      modelTier: "balanced",
      finalTier: "balanced",
    });
    const legacyStory = makeStoryMetrics({
      storyId: "US-002",
      complexity: "complex",
      // no initialComplexity
      modelTier: "powerful",
      finalTier: "powerful",
    });

    const runs = [makeRun([modernStory, legacyStory])];
    const aggregate = calculateAggregateMetrics(runs);

    expect(aggregate.complexityAccuracy["simple"]).toBeDefined();   // from initialComplexity
    expect(aggregate.complexityAccuracy["complex"]).toBeDefined();  // from complexity fallback
    expect(aggregate.complexityAccuracy["medium"]).toBeUndefined(); // NOT used (initialComplexity takes over)
  });

  test("complexityAccuracy.predicted count matches number of stories with that initialComplexity", () => {
    const stories = [
      makeStoryMetrics({ storyId: "US-001", complexity: "medium", initialComplexity: "simple", finalTier: "balanced" }),
      makeStoryMetrics({ storyId: "US-002", complexity: "medium", initialComplexity: "simple", finalTier: "balanced" }),
      makeStoryMetrics({ storyId: "US-003", complexity: "complex", initialComplexity: "complex", finalTier: "powerful" }),
    ];

    const runs = [makeRun(stories)];
    const aggregate = calculateAggregateMetrics(runs);

    expect(aggregate.complexityAccuracy["simple"].predicted).toBe(2);
    expect(aggregate.complexityAccuracy["complex"].predicted).toBe(1);
  });
});
