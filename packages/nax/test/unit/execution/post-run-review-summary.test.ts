/**
 * ENH-20: fail-open review checks (LLM dispatch failure degrading a gate to
 * success:true, failOpen:true) must be distinguishable from a genuine pass.
 */

import { describe, expect, test } from "bun:test";
import { sumReviewsFailedOpen } from "@/execution/post-run-review-summary";
import type { StoryMetrics } from "@/metrics/types";

function makeStoryMetrics(overrides: Partial<StoryMetrics> = {}): StoryMetrics {
  return {
    storyId: "US-001",
    complexity: "medium",
    modelTier: "balanced",
    modelUsed: "claude-sonnet-4",
    attempts: 1,
    finalTier: "balanced",
    success: true,
    cost: 0.01,
    durationMs: 1000,
    firstPassSuccess: true,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("applyReviewsFailedOpen removal (US-001 pipeline-review-delete)", () => {
  test("the module no longer exports applyReviewsFailedOpen", async () => {
    // The function's only caller went with the pipeline story loop (B2b-1), so
    // this wave deletes it. Read the module namespace dynamically: a static
    // import of a removed name would be a compile error, not a failing test.
    const summary = await import("@/execution/post-run-review-summary");
    expect(Object.keys(summary)).not.toContain("applyReviewsFailedOpen");
  });

  test("the module still exports sumReviewsFailedOpen", async () => {
    const summary = await import("@/execution/post-run-review-summary");
    expect(Object.keys(summary)).toContain("sumReviewsFailedOpen");
  });
});

describe("sumReviewsFailedOpen", () => {
  test("sums reviewsFailedOpen across every story", () => {
    const total = sumReviewsFailedOpen([
      makeStoryMetrics({ storyId: "US-001", reviewsFailedOpen: 1 }),
      makeStoryMetrics({ storyId: "US-002", reviewsFailedOpen: 2 }),
      makeStoryMetrics({ storyId: "US-003" }),
    ]);
    expect(total).toBe(3);
  });

  test("returns undefined (not 0) when no story fail-opened", () => {
    const total = sumReviewsFailedOpen([
      makeStoryMetrics({ storyId: "US-001" }),
      makeStoryMetrics({ storyId: "US-002", reviewsFailedOpen: 0 }),
    ]);
    expect(total).toBeUndefined();
  });

  test("returns undefined for an empty run", () => {
    expect(sumReviewsFailedOpen([])).toBeUndefined();
  });
});
