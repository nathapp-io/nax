/**
 * Unit tests for fail-open rejection in recheckReview() — issue #677.
 *
 * recheckReview() must return false when any check in the re-run result has
 * failOpen:true, even if ctx.reviewResult.success would otherwise be true.
 * Prevents partial-progress retry from whitewashing stories with real blocking findings.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _autofixDeps, autofixStage } from "../../../../src/pipeline/stages/autofix";
import { DEFAULT_CONFIG } from "../../../../src/config";
import type { PipelineContext } from "../../../../src/pipeline/types";
import type { ReviewCheckResult } from "../../../../src/review/types";
import { makeMockAgentManager, makeSessionManager } from "../../../helpers";

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

// ---------------------------------------------------------------------------
// Issue #832 Fix 1: verify callback sets failOpenAborted → shouldAbort exits
// before the next buildPrompt, preventing a wasted implementer call with stale
// findings.
// ---------------------------------------------------------------------------

describe("runAgentRectification — fail-open aborts retry loop (issue #832)", () => {
  test("aborts loop before attempt 2 when recheck detects adversarial fail-open", async () => {
    const { runAgentRectification } = await import("../../../../src/pipeline/stages/autofix-agent");

    let runAsSessionCallCount = 0;
    const agentManager = makeMockAgentManager({
      runAsSessionFn: async () => {
        runAsSessionCallCount++;
        return {
          output: "Fixed the issues",
          estimatedCostUsd: 0.01,
          tokenUsage: { inputTokens: 100, outputTokens: 200 },
          internalRoundTrips: 0,
        };
      },
    });

    const sessionManager = makeSessionManager();

    const savedCaptureGitRef = _autofixDeps.captureGitRef;
    const savedRecheckReview = _autofixDeps.recheckReview;

    // Both before/after return undefined → sourceFilesChanged=true, noOp=false,
    // so recheckWorthwhile=true and recheckReview is invoked.
    _autofixDeps.captureGitRef = async () => undefined as unknown as string;
    _autofixDeps.recheckReview = async (mockCtx: PipelineContext) => {
      // Simulate: adversarial timed out during recheck — success:true but failOpen:true
      mockCtx.reviewResult = {
        success: false,
        checks: [
          {
            check: "adversarial",
            success: true,
            failOpen: true,
            command: "",
            exitCode: 0,
            output: "fail-open",
            durationMs: 0,
          },
        ],
      } as unknown as PipelineContext["reviewResult"];
      return false;
    };

    const ctx = makeCtx({
      reviewResult: {
        success: false,
        checks: [
          {
            check: "adversarial",
            success: false,
            command: "",
            exitCode: 1,
            output: "adversarial finding",
            durationMs: 0,
          },
        ],
      } as unknown as PipelineContext["reviewResult"],
      config: {
        ...DEFAULT_CONFIG,
        quality: {
          ...DEFAULT_CONFIG.quality,
          autofix: { enabled: true, maxAttempts: 3, maxTotalAttempts: 12 },
        },
      } as PipelineContext["config"],
      agentManager,
      runtime: {
        sessionManager,
        signal: new AbortController().signal,
      } as unknown as PipelineContext["runtime"],
    });

    const result = await runAgentRectification(ctx, undefined, undefined, "/tmp");

    _autofixDeps.captureGitRef = savedCaptureGitRef;
    _autofixDeps.recheckReview = savedRecheckReview;

    expect(result.succeeded).toBe(false);
    // shouldAbort fires after attempt 1's verify — attempt 2 must not be built
    expect(runAsSessionCallCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Issue #832 Fix 2: currentlyFailing includes failOpen checks so adversarial
// timeout is not added to retrySkipChecks on the partial-progress path.
// ---------------------------------------------------------------------------

describe("autofixStage — fail-open excluded from retrySkipChecks (issue #832)", () => {
  test("adversarial fail-open is NOT added to retrySkipChecks when lint is cleared", async () => {
    const saved = { ..._autofixDeps };

    _autofixDeps.runAgentRectification = async (mockCtx: PipelineContext) => {
      mockCtx.autofixAttempt = 1;
      // Simulate: lint resolved but adversarial timed out (fail-open)
      mockCtx.reviewResult = {
        success: false,
        checks: [
          { check: "lint", success: true, command: "", exitCode: 0, output: "", durationMs: 0 },
          {
            check: "adversarial",
            success: true,
            failOpen: true,
            command: "",
            exitCode: 0,
            output: "fail-open",
            durationMs: 0,
          },
        ],
      } as unknown as PipelineContext["reviewResult"];
      return { succeeded: false, cost: 0 };
    };

    const ctx = makeCtx({
      reviewResult: {
        success: false,
        checks: [
          { check: "lint", success: false, command: "", exitCode: 1, output: "lint error", durationMs: 0 },
          {
            check: "adversarial",
            success: false,
            command: "",
            exitCode: 1,
            output: "adversarial finding",
            durationMs: 0,
          },
        ],
      } as unknown as PipelineContext["reviewResult"],
    });

    const result = await autofixStage.execute(ctx);

    Object.assign(_autofixDeps, saved);

    // lint was genuinely cleared → partial progress → retry
    expect(result.action).toBe("retry");
    // lint cleared for real → skip on next cycle
    expect(ctx.retrySkipChecks?.has("lint")).toBe(true);
    // adversarial timed out (failOpen) → must NOT be treated as passing
    expect(ctx.retrySkipChecks?.has("adversarial")).toBe(false);
  });
});
