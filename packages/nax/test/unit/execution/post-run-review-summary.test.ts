/**
 * ENH-20: fail-open review checks (LLM dispatch failure degrading a gate to
 * success:true, failOpen:true) must be distinguishable from a genuine pass.
 */

import { describe, expect, test } from "bun:test";
import { applyReviewsFailedOpen, sumReviewsFailedOpen } from "@/execution/post-run-review-summary";
import type { StoryMetrics } from "@/metrics/types";
import type { PipelineContext } from "@/pipeline/types";

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

describe("applyReviewsFailedOpen", () => {
  test("counts a fail-opened semantic-review phase", () => {
    const ctx = {} as PipelineContext;
    applyReviewsFailedOpen(ctx, { "semantic-review": { success: true, failOpen: true } });
    expect(ctx.reviewsFailedOpen).toBe(1);
  });

  test("counts both semantic and adversarial fail-opens", () => {
    const ctx = {} as PipelineContext;
    applyReviewsFailedOpen(ctx, {
      "semantic-review": { success: true, failOpen: true },
      "adversarial-review": { success: true, failOpen: true },
    });
    expect(ctx.reviewsFailedOpen).toBe(2);
  });

  test("leaves ctx.reviewsFailedOpen unset when neither review fail-opened", () => {
    const ctx = {} as PipelineContext;
    applyReviewsFailedOpen(ctx, {
      "semantic-review": { success: true },
      "adversarial-review": { success: true },
    });
    expect(ctx.reviewsFailedOpen).toBeUndefined();
  });

  test("leaves ctx.reviewsFailedOpen unset when the review phases are absent", () => {
    const ctx = {} as PipelineContext;
    applyReviewsFailedOpen(ctx, {});
    expect(ctx.reviewsFailedOpen).toBeUndefined();
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
