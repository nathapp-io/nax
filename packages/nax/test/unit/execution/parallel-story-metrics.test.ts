/**
 * nax#1709: parallel/worktree execution builds its StoryMetrics inline and never calls
 * collectStoryMetrics, so agent-swap hops and crash retries recorded during a parallel
 * batch were written to the run-scoped stores and never read. For `parallelCount > 1`
 * runs the swap-cost metric stayed absent exactly as it was before #1707.
 *
 * The literals are extracted here so the synthesis is a pure, testable function — the
 * same shape as `backfill-story-metrics.ts` for the failure path.
 */

import { describe, expect, test } from "bun:test";
import { makeStory } from "@test/helpers";
import { synthesizeParallelStoryMetric } from "@/execution";

const STARTED = "2026-08-25T00:00:00.000Z";
const COMPLETED = "2026-08-25T00:05:00.000Z";

const HOP = {
  storyId: "US-001",
  priorAgent: "claude",
  newAgent: "codex",
  hop: 1,
  outcome: "fail-quota",
  category: "availability",
  costUsd: 0.4,
} as const;

function base() {
  return {
    story: makeStory({
      id: "US-001",
      routing: {
        modelTier: "powerful",
        complexity: "complex",
        testStrategy: "test-after",
        reasoning: "t",
      },
    }),
    modelUsed: "claude",
    cost: 1.5,
    durationMs: 300_000,
    startedAt: STARTED,
    completedAt: COMPLETED,
    source: "parallel" as const,
    firstPassSuccess: true,
  };
}

describe("synthesizeParallelStoryMetric (#1709)", () => {
  test("preserves the shape the inline literal produced", () => {
    const m = synthesizeParallelStoryMetric(base());

    expect(m.storyId).toBe("US-001");
    expect(m.complexity).toBe("complex");
    expect(m.modelTier).toBe("powerful");
    expect(m.finalTier).toBe("powerful");
    expect(m.modelUsed).toBe("claude");
    expect(m.attempts).toBe(1);
    expect(m.success).toBe(true);
    expect(m.cost).toBe(1.5);
    expect(m.durationMs).toBe(300_000);
    expect(m.firstPassSuccess).toBe(true);
    expect(m.startedAt).toBe(STARTED);
    expect(m.completedAt).toBe(COMPLETED);
    expect(m.source).toBe("parallel");
  });

  test("defaults tier and complexity when the story carries no routing", () => {
    const m = synthesizeParallelStoryMetric({ ...base(), story: makeStory({ id: "US-002", routing: undefined }) });

    expect(m.complexity).toBe("medium");
    expect(m.modelTier).toBe("balanced");
    expect(m.finalTier).toBe("balanced");
  });

  test("carries agent-swap hops recorded during the parallel batch", () => {
    const m = synthesizeParallelStoryMetric({ ...base(), fallbackHops: [HOP] });

    expect(m.fallback?.hops).toEqual([HOP]);
  });

  test("carries the crash-retry tally", () => {
    const m = synthesizeParallelStoryMetric({ ...base(), runtimeCrashes: 2 });

    expect(m.runtimeCrashes).toBe(2);
  });

  test("omits fallback when the story had no swaps", () => {
    const m = synthesizeParallelStoryMetric({ ...base(), fallbackHops: [] });

    expect(m.fallback).toBeUndefined();
    expect(m.runtimeCrashes).toBe(0);
  });

  test("carries rectificationCost for a merge-conflict rectified story", () => {
    const m = synthesizeParallelStoryMetric({
      ...base(),
      source: "rectification",
      firstPassSuccess: false,
      rectificationCost: 0.25,
    });

    expect(m.source).toBe("rectification");
    expect(m.firstPassSuccess).toBe(false);
    expect(m.rectificationCost).toBe(0.25);
  });

  test("omits rectificationCost when none was incurred", () => {
    const m = synthesizeParallelStoryMetric(base());

    expect(m.rectificationCost).toBeUndefined();
  });
});
