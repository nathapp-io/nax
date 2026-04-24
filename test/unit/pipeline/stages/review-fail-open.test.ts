/**
 * Unit tests for fail-closed-on-retry guard in review stage — issue #677.
 *
 * When a reviewer fail-opens (success:true, failOpen:true) in a retry context
 * (ctx.autofixAttempt > 0), the review stage must treat it as a failure, not
 * a pass. This prevents partial-progress retry from whitewashing stories that
 * still have blocking findings.
 *
 * When autofixAttempt = 0 (first run), fail-open still counts as pass — that
 * behavior is intentional and must not regress.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../../../src/config";
import { reviewStage } from "../../../../src/pipeline/stages/review";
import type { PipelineContext } from "../../../../src/pipeline/types";
import type { ReviewCheckResult } from "../../../../src/review/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCheckResult(overrides: Partial<ReviewCheckResult> = {}): ReviewCheckResult {
  return {
    check: "adversarial",
    success: true,
    command: "",
    exitCode: 0,
    output: "adversarial review: could not parse LLM response (fail-open)",
    durationMs: 50,
    ...overrides,
  };
}

function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    config: {
      ...DEFAULT_CONFIG,
      review: { ...DEFAULT_CONFIG.review, enabled: true },
    } as PipelineContext["config"],
    prd: { stories: [], feature: "test-feature" } as unknown as PipelineContext["prd"],
    story: { id: "US-001", title: "t", status: "in-progress", acceptanceCriteria: [] } as unknown as PipelineContext["story"],
    stories: [],
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    rootConfig: DEFAULT_CONFIG,
    workdir: "/tmp",
    projectDir: "/tmp",
    hooks: { hooks: {} } as PipelineContext["hooks"],
    ...overrides,
  } as unknown as PipelineContext;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("reviewStage — fail-open + retry context (autofixAttempt > 0)", () => {
  let origReviewFromContext: unknown;

  beforeEach(async () => {
    const { reviewOrchestrator } = await import("../../../../src/review/orchestrator");
    origReviewFromContext = reviewOrchestrator.reviewFromContext;
  });

  afterEach(async () => {
    const { reviewOrchestrator } = await import("../../../../src/review/orchestrator");
    (reviewOrchestrator as unknown as Record<string, unknown>).reviewFromContext = origReviewFromContext;
  });

  test("sets ctx.reviewResult.success=false when adversarial fail-opens in retry context", async () => {
    const { reviewOrchestrator } = await import("../../../../src/review/orchestrator");
    (reviewOrchestrator as unknown as Record<string, unknown>).reviewFromContext = mock(async () => ({
      success: true,
      pluginFailed: false,
      builtIn: {
        success: true,
        checks: [makeCheckResult({ check: "adversarial", failOpen: true })],
        totalDurationMs: 50,
      },
    }));

    const ctx = makeCtx({ autofixAttempt: 3 });
    await reviewStage.execute(ctx);

    expect(ctx.reviewResult?.success).toBe(false);
  });

  test("includes failureReason naming the fail-open check", async () => {
    const { reviewOrchestrator } = await import("../../../../src/review/orchestrator");
    (reviewOrchestrator as unknown as Record<string, unknown>).reviewFromContext = mock(async () => ({
      success: true,
      pluginFailed: false,
      builtIn: {
        success: true,
        checks: [makeCheckResult({ check: "adversarial", failOpen: true })],
        totalDurationMs: 50,
      },
    }));

    const ctx = makeCtx({ autofixAttempt: 2 });
    await reviewStage.execute(ctx);

    expect(ctx.reviewResult?.failureReason).toContain("adversarial");
  });

  test("still returns action:continue so autofix stage can handle the retry", async () => {
    const { reviewOrchestrator } = await import("../../../../src/review/orchestrator");
    (reviewOrchestrator as unknown as Record<string, unknown>).reviewFromContext = mock(async () => ({
      success: true,
      pluginFailed: false,
      builtIn: {
        success: true,
        checks: [makeCheckResult({ check: "adversarial", failOpen: true })],
        totalDurationMs: 50,
      },
    }));

    const ctx = makeCtx({ autofixAttempt: 1 });
    const result = await reviewStage.execute(ctx);

    expect(result.action).toBe("continue");
  });
});

describe("reviewStage — fail-open + first run (autofixAttempt = 0)", () => {
  let origReviewFromContext: unknown;

  beforeEach(async () => {
    const { reviewOrchestrator } = await import("../../../../src/review/orchestrator");
    origReviewFromContext = reviewOrchestrator.reviewFromContext;
  });

  afterEach(async () => {
    const { reviewOrchestrator } = await import("../../../../src/review/orchestrator");
    (reviewOrchestrator as unknown as Record<string, unknown>).reviewFromContext = origReviewFromContext;
  });

  test("still treats fail-open as pass when autofixAttempt is 0 (first run)", async () => {
    const { reviewOrchestrator } = await import("../../../../src/review/orchestrator");
    (reviewOrchestrator as unknown as Record<string, unknown>).reviewFromContext = mock(async () => ({
      success: true,
      pluginFailed: false,
      builtIn: {
        success: true,
        checks: [makeCheckResult({ check: "adversarial", failOpen: true })],
        totalDurationMs: 50,
      },
    }));

    const ctx = makeCtx({ autofixAttempt: 0 });
    await reviewStage.execute(ctx);

    expect(ctx.reviewResult?.success).toBe(true);
  });

  test("still treats fail-open as pass when autofixAttempt is undefined (first run)", async () => {
    const { reviewOrchestrator } = await import("../../../../src/review/orchestrator");
    (reviewOrchestrator as unknown as Record<string, unknown>).reviewFromContext = mock(async () => ({
      success: true,
      pluginFailed: false,
      builtIn: {
        success: true,
        checks: [makeCheckResult({ check: "adversarial", failOpen: true })],
        totalDurationMs: 50,
      },
    }));

    const ctx = makeCtx();
    await reviewStage.execute(ctx);

    expect(ctx.reviewResult?.success).toBe(true);
  });

  test("treats genuine pass with no fail-open and autofixAttempt > 0 as pass (no regression)", async () => {
    const { reviewOrchestrator } = await import("../../../../src/review/orchestrator");
    (reviewOrchestrator as unknown as Record<string, unknown>).reviewFromContext = mock(async () => ({
      success: true,
      pluginFailed: false,
      builtIn: {
        success: true,
        checks: [makeCheckResult({ check: "adversarial" })],
        totalDurationMs: 50,
      },
    }));

    const ctx = makeCtx({ autofixAttempt: 5 });
    await reviewStage.execute(ctx);

    expect(ctx.reviewResult?.success).toBe(true);
  });
});
