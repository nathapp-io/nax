/**
 * Unit tests for fail-open rejection in recheckReview() — issue #677.
 *
 * recheckReview() must return false when any check in the re-run result has
 * failOpen:true, even if ctx.reviewResult.success would otherwise be true.
 * Prevents partial-progress retry from whitewashing stories with real blocking findings.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _autofixDeps } from "../../../../src/pipeline/stages/autofix";
import { DEFAULT_CONFIG } from "../../../../src/config";
import type { PipelineContext } from "../../../../src/pipeline/types";
import type { ReviewCheckResult } from "../../../../src/review/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCheckResult(overrides: Partial<ReviewCheckResult>): ReviewCheckResult {
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
    prd: { stories: [] } as unknown as PipelineContext["prd"],
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

describe("recheckReview — fail-open rejection", () => {
  let origReviewFromContext: unknown;

  beforeEach(async () => {
    const { reviewOrchestrator } = await import("../../../../src/review/orchestrator");
    origReviewFromContext = reviewOrchestrator.reviewFromContext;
  });

  afterEach(async () => {
    const { reviewOrchestrator } = await import("../../../../src/review/orchestrator");
    (reviewOrchestrator as unknown as Record<string, unknown>).reviewFromContext = origReviewFromContext;
  });

  test("returns false when adversarial fail-opens (success:true, failOpen:true)", async () => {
    const { reviewOrchestrator } = await import("../../../../src/review/orchestrator");
    (reviewOrchestrator as unknown as Record<string, unknown>).reviewFromContext = mock(async () => ({
      success: true,
      pluginFailed: false,
      builtIn: {
        success: true,
        checks: [makeCheckResult({ check: "adversarial", success: true, failOpen: true })],
        totalDurationMs: 50,
      },
    }));

    const ctx = makeCtx();
    const result = await _autofixDeps.recheckReview(ctx);

    expect(result).toBe(false);
  });

  test("returns false when semantic fail-opens (success:true, failOpen:true)", async () => {
    const { reviewOrchestrator } = await import("../../../../src/review/orchestrator");
    (reviewOrchestrator as unknown as Record<string, unknown>).reviewFromContext = mock(async () => ({
      success: true,
      pluginFailed: false,
      builtIn: {
        success: true,
        checks: [makeCheckResult({ check: "semantic", success: true, failOpen: true })],
        totalDurationMs: 50,
      },
    }));

    const ctx = makeCtx();
    const result = await _autofixDeps.recheckReview(ctx);

    expect(result).toBe(false);
  });

  test("returns true when review passes with no fail-open (unchanged behavior)", async () => {
    const { reviewOrchestrator } = await import("../../../../src/review/orchestrator");
    (reviewOrchestrator as unknown as Record<string, unknown>).reviewFromContext = mock(async () => ({
      success: true,
      pluginFailed: false,
      builtIn: {
        success: true,
        checks: [makeCheckResult({ check: "adversarial", success: true })],
        totalDurationMs: 50,
      },
    }));

    const ctx = makeCtx();
    const result = await _autofixDeps.recheckReview(ctx);

    expect(result).toBe(true);
  });

  test("returns false when review genuinely fails (success:false, no fail-open)", async () => {
    const { reviewOrchestrator } = await import("../../../../src/review/orchestrator");
    (reviewOrchestrator as unknown as Record<string, unknown>).reviewFromContext = mock(async () => ({
      success: false,
      pluginFailed: false,
      failureReason: "adversarial failed",
      builtIn: {
        success: false,
        checks: [makeCheckResult({ check: "adversarial", success: false })],
        totalDurationMs: 50,
      },
    }));

    const ctx = makeCtx();
    const result = await _autofixDeps.recheckReview(ctx);

    expect(result).toBe(false);
  });

  test("returns true when review is disabled (no re-run needed)", async () => {
    const ctx = makeCtx({
      config: {
        ...DEFAULT_CONFIG,
        review: { ...DEFAULT_CONFIG.review, enabled: false },
      } as PipelineContext["config"],
    });

    const result = await _autofixDeps.recheckReview(ctx);

    expect(result).toBe(true);
  });
});
