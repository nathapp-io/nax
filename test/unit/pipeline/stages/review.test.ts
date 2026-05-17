/**
 * Unit tests for security-review trigger wiring in review stage (TC-003)
 * and semantic findings wiring into ctx.reviewFindings (US-003)
 *
 * Covers:
 * - Plugin reviewer failure with no trigger → always fail
 * - Plugin reviewer failure + trigger abort → fail
 * - Plugin reviewer failure + trigger non-abort → escalate
 * - Built-in check failure → escalate (unchanged)
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { DEFAULT_CONFIG } from "@/config";
import type { Finding } from "@/findings";
import { InteractionChain } from "@/interaction";
import type { InteractionPlugin, InteractionResponse } from "@/interaction/types";
import { _reviewDeps, reviewStage } from "../../../../src/pipeline/stages/review";
import type { PipelineContext } from "@/pipeline/types";
import type { PRD, UserStory } from "@/prd";
import type { ReviewFinding } from "@/plugins/extensions";
import { makeSparseNaxConfig, makeStory } from "@test/helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const originalCheckSecurityReview = _reviewDeps.checkSecurityReview;

function makeChain(action: InteractionResponse["action"]): InteractionChain {
  const chain = new InteractionChain({ defaultTimeout: 5000, defaultFallback: "abort" });
  const plugin: InteractionPlugin = {
    name: "test",
    send: mock(async () => {}),
    receive: mock(async (id: string): Promise<InteractionResponse> => ({
      requestId: id,
      action,
      respondedBy: "user",
      respondedAt: Date.now(),
    })),
  };
  chain.register(plugin);
  return chain;
}

function makePRD(): PRD {
  return {
    project: "test",
    feature: "my-feature",
    branchName: "test-branch",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: [makeStory({ status: "in-progress", attempts: 1 })],
  };
}

function makeCtx(overrides: Partial<PipelineContext>): PipelineContext {
  return {
    config: makeSparseNaxConfig({ review: { enabled: true }, interaction: { plugin: "cli", defaults: { timeout: 30000, fallback: "abort" as const }, triggers: {} } }),
    prd: makePRD(),
    story: makeStory({ status: "in-progress", attempts: 1 }),
    stories: [makeStory({ status: "in-progress", attempts: 1 })],
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    rootConfig: DEFAULT_CONFIG,
    workdir: "/tmp/test",
    projectDir: "/tmp/test",
    hooks: {} as PipelineContext["hooks"],
    ...overrides,
  } as unknown as PipelineContext;
}

afterEach(() => {
  mock.restore();
  _reviewDeps.checkSecurityReview = originalCheckSecurityReview;
});

// ─────────────────────────────────────────────────────────────────────────────
// pluginMode deferred — stage-level paths (DR-002)
// ─────────────────────────────────────────────────────────────────────────────

describe("reviewStage — pluginMode deferred path", () => {
  test("returns continue when pluginMode is deferred and built-in checks pass", async () => {
    const reviewResult = {
      success: true,
      pluginFailed: false,
      builtIn: { totalDurationMs: 5 },
    };
    const { reviewOrchestrator } = await import("../../../../src/review/orchestrator");
    const original = reviewOrchestrator.review;
    reviewOrchestrator.review = mock(async () => reviewResult) as typeof reviewOrchestrator.review;

    const config = makeSparseNaxConfig({ review: { enabled: true }, interaction: { plugin: "cli", defaults: { timeout: 30000, fallback: "abort" as const }, triggers: {} } });
    config.review.pluginMode = "deferred";
    const ctx = makeCtx({ config });
    const result = await reviewStage.execute(ctx);

    expect(result.action).toBe("continue");
    reviewOrchestrator.review = original;
  });

  test("passes pluginMode deferred in reviewConfig to orchestrator", async () => {
    const { reviewOrchestrator } = await import("../../../../src/review/orchestrator");
    const original = reviewOrchestrator.review;
    const orchestratorMock = mock(async () => ({
      success: true,
      pluginFailed: false,
      builtIn: { totalDurationMs: 0 },
    }));
    reviewOrchestrator.review = orchestratorMock as typeof reviewOrchestrator.review;

    const config = makeSparseNaxConfig({ review: { enabled: true }, interaction: { plugin: "cli", defaults: { timeout: 30000, fallback: "abort" as const }, triggers: {} } });
    config.review.pluginMode = "deferred";
    const ctx = makeCtx({ config });
    await reviewStage.execute(ctx);

    const calledConfig = orchestratorMock.mock.calls[0]?.[0];
    expect(calledConfig?.reviewConfig?.pluginMode).toBe("deferred");
    reviewOrchestrator.review = original;
  });

  test("returns continue on built-in check failure (hands off to autofix) even when pluginMode is deferred", async () => {
    const reviewResult = {
      success: false,
      pluginFailed: false,
      failureReason: "typecheck failed",
      builtIn: { totalDurationMs: 0 },
    };
    const { reviewOrchestrator } = await import("../../../../src/review/orchestrator");
    const original = reviewOrchestrator.review;
    reviewOrchestrator.review = mock(async () => reviewResult) as typeof reviewOrchestrator.review;

    const config = makeSparseNaxConfig({ review: { enabled: true }, interaction: { plugin: "cli", defaults: { timeout: 30000, fallback: "abort" as const }, triggers: {} } });
    config.review.pluginMode = "deferred";
    const ctx = makeCtx({ config });
    const result = await reviewStage.execute(ctx);

    // Built-in check failures return "continue" — autofix stage handles the retry
    expect(result.action).toBe("continue");
    reviewOrchestrator.review = original;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Plugin reviewer failure — no trigger configured (today behavior)
// ─────────────────────────────────────────────────────────────────────────────

describe("reviewStage — plugin failure, no trigger", () => {
  test("returns fail when plugin reviewer fails and trigger not enabled", async () => {
    const reviewResult = { success: false, pluginFailed: true, failureReason: "semgrep found issues", builtIn: { totalDurationMs: 0 } };
    const orchestratorMock = mock(async () => reviewResult);
    // biome-ignore lint/suspicious/noExplicitAny: test-only import override
    const { reviewOrchestrator } = await import("../../../../src/review/orchestrator");
    const original = reviewOrchestrator.review;
    reviewOrchestrator.review = orchestratorMock as typeof reviewOrchestrator.review;

    const ctx = makeCtx({ config: makeSparseNaxConfig({ review: { enabled: true }, interaction: { plugin: "cli", defaults: { timeout: 30000, fallback: "abort" as const }, triggers: {} } }) });
    const result = await reviewStage.execute(ctx);

    expect(result.action).toBe("fail");
    reviewOrchestrator.review = original;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Plugin reviewer failure — trigger wired via _reviewDeps
// ─────────────────────────────────────────────────────────────────────────────

describe("reviewStage — security-review trigger via _reviewDeps", () => {
  test("returns fail when trigger responds abort (checkSecurityReview returns false)", async () => {
    _reviewDeps.checkSecurityReview = mock(async () => false);

    const reviewResult = { success: false, pluginFailed: true, failureReason: "semgrep critical", builtIn: { totalDurationMs: 0 } };
    const { reviewOrchestrator } = await import("../../../../src/review/orchestrator");
    const original = reviewOrchestrator.review;
    reviewOrchestrator.review = mock(async () => reviewResult) as typeof reviewOrchestrator.review;

    const chain = makeChain("abort");
    const ctx = makeCtx({
      config: makeSparseNaxConfig({ review: { enabled: true }, interaction: { plugin: "cli", defaults: { timeout: 30000, fallback: "abort" as const }, triggers: { "security-review": { enabled: true } } } }),
      interaction: chain,
    });
    const result = await reviewStage.execute(ctx);

    expect(result.action).toBe("fail");
    expect(_reviewDeps.checkSecurityReview).toHaveBeenCalledTimes(1);
    reviewOrchestrator.review = original;
  });

  test("returns escalate when trigger responds non-abort (checkSecurityReview returns true)", async () => {
    _reviewDeps.checkSecurityReview = mock(async () => true);

    const reviewResult = { success: false, pluginFailed: true, failureReason: "semgrep warning", builtIn: { totalDurationMs: 0 } };
    const { reviewOrchestrator } = await import("../../../../src/review/orchestrator");
    const original = reviewOrchestrator.review;
    reviewOrchestrator.review = mock(async () => reviewResult) as typeof reviewOrchestrator.review;

    const chain = makeChain("approve");
    const ctx = makeCtx({
      config: makeSparseNaxConfig({ review: { enabled: true }, interaction: { plugin: "cli", defaults: { timeout: 30000, fallback: "abort" as const }, triggers: { "security-review": { enabled: true } } } }),
      interaction: chain,
    });
    const result = await reviewStage.execute(ctx);

    expect(result.action).toBe("escalate");
    expect(_reviewDeps.checkSecurityReview).toHaveBeenCalledTimes(1);
    reviewOrchestrator.review = original;
  });

  test("does not call trigger when no interaction chain present", async () => {
    _reviewDeps.checkSecurityReview = mock(async () => true);

    const reviewResult = { success: false, pluginFailed: true, failureReason: "semgrep error", builtIn: { totalDurationMs: 0 } };
    const { reviewOrchestrator } = await import("../../../../src/review/orchestrator");
    const original = reviewOrchestrator.review;
    reviewOrchestrator.review = mock(async () => reviewResult) as typeof reviewOrchestrator.review;

    const ctx = makeCtx({
      config: makeSparseNaxConfig({ review: { enabled: true }, interaction: { plugin: "cli", defaults: { timeout: 30000, fallback: "abort" as const }, triggers: { "security-review": { enabled: true } } } }),
      // no interaction
    });
    const result = await reviewStage.execute(ctx);

    expect(result.action).toBe("fail");
    expect(_reviewDeps.checkSecurityReview).not.toHaveBeenCalled();
    reviewOrchestrator.review = original;
  });

  test("built-in check failure returns continue (hands off to autofix, security-review trigger not fired)", async () => {
    _reviewDeps.checkSecurityReview = mock(async () => false);

    const reviewResult = { success: false, pluginFailed: false, failureReason: "lint failed", builtIn: { totalDurationMs: 0 } };
    const { reviewOrchestrator } = await import("../../../../src/review/orchestrator");
    const original = reviewOrchestrator.review;
    reviewOrchestrator.review = mock(async () => reviewResult) as typeof reviewOrchestrator.review;

    const ctx = makeCtx({
      config: makeSparseNaxConfig({ review: { enabled: true }, interaction: { plugin: "cli", defaults: { timeout: 30000, fallback: "abort" as const }, triggers: { "security-review": { enabled: true } } } }),
      interaction: makeChain("abort"),
    });
    const result = await reviewStage.execute(ctx);

    // Built-in failures return "continue" — autofix handles it, not escalation
    expect(result.action).toBe("continue");
    // security-review trigger should NOT fire for built-in check failures
    expect(_reviewDeps.checkSecurityReview).not.toHaveBeenCalled();
    reviewOrchestrator.review = original;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Semantic findings wired into ctx.reviewFindings (US-003)
// ─────────────────────────────────────────────────────────────────────────────

describe("reviewStage — semantic findings wired into ctx.reviewFindings (US-003)", () => {
  // AC-1: ctx.reviewFindings is populated when semantic check fails with findings

  test("populates ctx.reviewFindings when semantic check returns success=false with findings", async () => {
    const semanticFindings: Finding[] = [
      {
        source: "semantic-review",
        rule: "semantic",
        severity: "error",
        category: "semantic",
        file: "src/review/runner.ts",
        line: 42,
        message: "Missing wiring",
      },
    ];

    const reviewResult = {
      success: false,
      pluginFailed: false,
      failureReason: "semantic failed",
      builtIn: {
        success: false,
        totalDurationMs: 0,
        checks: [
          {
            check: "semantic",
            success: false,
            command: "",
            exitCode: 1,
            output: "Semantic review failed",
            durationMs: 100,
            findings: semanticFindings,
          },
        ],
      },
    };

    const { reviewOrchestrator } = await import("../../../../src/review/orchestrator");
    const original = reviewOrchestrator.review;
    reviewOrchestrator.review = mock(async () => reviewResult) as typeof reviewOrchestrator.review;

    const ctx = makeCtx({});
    await reviewStage.execute(ctx);

    expect(ctx.reviewFindings).toBeDefined();
    expect(ctx.reviewFindings!.length).toBe(1);
    reviewOrchestrator.review = original;
  });

  // AC-2: correct field mapping verified at stage level
  test("ctx.reviewFindings contains findings with source='semantic-review' and rule='semantic'", async () => {
    const semanticFindings: Finding[] = [
      {
        source: "semantic-review",
        rule: "semantic",
        severity: "error",
        category: "semantic",
        file: "src/foo.ts",
        line: 10,
        message: "Stub left in code",
      },
      {
        source: "semantic-review",
        rule: "semantic",
        severity: "warning",
        category: "semantic",
        file: "src/bar.ts",
        line: 25,
        message: "TODO not addressed",
      },
    ];

    const reviewResult = {
      success: false,
      pluginFailed: false,
      failureReason: "semantic failed",
      builtIn: {
        success: false,
        totalDurationMs: 0,
        checks: [
          { check: "semantic", success: false, command: "", exitCode: 1, output: "", durationMs: 50, findings: semanticFindings },
        ],
      },
    };

    const { reviewOrchestrator } = await import("../../../../src/review/orchestrator");
    const original = reviewOrchestrator.review;
    reviewOrchestrator.review = mock(async () => reviewResult) as typeof reviewOrchestrator.review;

    const ctx = makeCtx({});
    await reviewStage.execute(ctx);

    expect(ctx.reviewFindings).toHaveLength(2);
    for (const f of ctx.reviewFindings!) {
      expect(f.source).toBe("semantic-review");
      expect(f.rule).toBe("semantic");
    }
    expect(ctx.reviewFindings![0].file).toBe("src/foo.ts");
    expect(ctx.reviewFindings![0].line).toBe(10);
    expect(ctx.reviewFindings![0].message).toBe("Stub left in code");
    reviewOrchestrator.review = original;
  });

  // AC-3: findings structured for priorFailures context (source/rule match context renderer expectations)
  test("ctx.reviewFindings has source='semantic-review' so context renderer includes tool source in retry context", async () => {
    const semanticFindings: Finding[] = [
      {
        source: "semantic-review",
        rule: "semantic",
        severity: "error",
        category: "semantic",
        file: "src/a.ts",
        line: 1,
        message: "Critical issue",
      },
    ];

    const reviewResult = {
      success: false,
      pluginFailed: false,
      failureReason: "semantic failed",
      builtIn: {
        success: false,
        totalDurationMs: 0,
        checks: [
          { check: "semantic", success: false, command: "", exitCode: 1, output: "", durationMs: 10, findings: semanticFindings },
        ],
      },
    };

    const { reviewOrchestrator } = await import("../../../../src/review/orchestrator");
    const original = reviewOrchestrator.review;
    reviewOrchestrator.review = mock(async () => reviewResult) as typeof reviewOrchestrator.review;

    const ctx = makeCtx({});
    await reviewStage.execute(ctx);

    // Findings must be present and have the correct shape so that
    // handleTierEscalation can attach them to priorFailures for retry context.
    expect(ctx.reviewFindings).toBeDefined();
    expect(ctx.reviewFindings![0].source).toBe("semantic-review");
    expect(ctx.reviewFindings![0].rule).toBe("semantic");
    expect(typeof ctx.reviewFindings![0].message).toBe("string");
    expect(ctx.reviewFindings![0].message.length).toBeGreaterThan(0);
    reviewOrchestrator.review = original;
  });

  // AC-4: ctx.reviewFindings NOT modified when semantic passes

  test("does not modify ctx.reviewFindings when semantic check passes (success=true)", async () => {
    const reviewResult = {
      success: true,
      pluginFailed: false,
      builtIn: {
        success: true,
        totalDurationMs: 0,
        checks: [
          { check: "semantic", success: true, command: "", exitCode: 0, output: "Semantic review passed", durationMs: 50 },
        ],
      },
    };

    const { reviewOrchestrator } = await import("../../../../src/review/orchestrator");
    const original = reviewOrchestrator.review;
    reviewOrchestrator.review = mock(async () => reviewResult) as typeof reviewOrchestrator.review;

    const ctx = makeCtx({});
    await reviewStage.execute(ctx);

    expect(ctx.reviewFindings).toBeUndefined();
    reviewOrchestrator.review = original;
  });

  test("does not modify ctx.reviewFindings when semantic check fails but has no findings", async () => {
    const reviewResult = {
      success: false,
      pluginFailed: false,
      failureReason: "semantic failed",
      builtIn: {
        success: false,
        totalDurationMs: 0,
        checks: [
          { check: "semantic", success: false, command: "", exitCode: 1, output: "failed (no findings)", durationMs: 10 },
        ],
      },
    };

    const { reviewOrchestrator } = await import("../../../../src/review/orchestrator");
    const original = reviewOrchestrator.review;
    reviewOrchestrator.review = mock(async () => reviewResult) as typeof reviewOrchestrator.review;

    const ctx = makeCtx({});
    await reviewStage.execute(ctx);

    // No findings → reviewFindings stays undefined (not empty array)
    expect(!ctx.reviewFindings || ctx.reviewFindings.length === 0).toBe(true);
    reviewOrchestrator.review = original;
  });

  test("returns continue when semantic check fails with findings (autofix handles it)", async () => {
    const semanticFindings: Finding[] = [
      {
        source: "semantic-review",
        rule: "semantic",
        severity: "error",
        category: "semantic",
        file: "src/a.ts",
        line: 1,
        message: "Issue",
      },
    ];

    const reviewResult = {
      success: false,
      pluginFailed: false,
      failureReason: "semantic failed",
      builtIn: {
        success: false,
        totalDurationMs: 0,
        checks: [
          { check: "semantic", success: false, command: "", exitCode: 1, output: "", durationMs: 10, findings: semanticFindings },
        ],
      },
    };

    const { reviewOrchestrator } = await import("../../../../src/review/orchestrator");
    const original = reviewOrchestrator.review;
    reviewOrchestrator.review = mock(async () => reviewResult) as typeof reviewOrchestrator.review;

    const ctx = makeCtx({});
    const result = await reviewStage.execute(ctx);

    expect(result.action).toBe("continue");
    reviewOrchestrator.review = original;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// skipLLMReviewers gating in reviewStage.execute (AC9–12)
// ─────────────────────────────────────────────────────────────────────────────

describe("reviewStage — skipLLMReviewers gating (AC9–12)", () => {
  // Helpers for reviewer session mocks
  function makeReviewerSession(overrides: Partial<{ review: () => Promise<any>; reReview: () => Promise<any> }> = {}) {
    return {
      review: async () => ({
        checkResult: { success: true, findings: [] },
        cost: 0,
      }),
      reReview: async () => ({
        checkResult: { success: true, findings: [] },
      }),
      ...overrides,
    };
  }

  function makeDialogueConfig() {
    return makeSparseNaxConfig({
      review: { enabled: true, dialogue: { enabled: true } },
      interaction: {
        plugin: "cli",
        defaults: { timeout: 30000, fallback: "abort" as const },
        triggers: {},
      },
    });
  }

  // AC9: retry branch — reReview() not called when skipLLMReviewers=true
  test("does not call reviewerSession.reReview() when skipLLMReviewers=true (AC9)", async () => {
    let reReviewCalled = false;
    const session = makeReviewerSession({
      reReview: async () => {
        reReviewCalled = true;
        return { checkResult: { success: true, findings: [] } };
      },
    });

    const ctx = makeCtx({
      config: makeDialogueConfig(),
      reviewerSession: session as any,
      skipLLMReviewers: true,
    });

    // Fall through to orchestrator — mock it to return pass
    const { reviewOrchestrator } = await import("../../../../src/review/orchestrator");
    const original = reviewOrchestrator.reviewFromContext;
    reviewOrchestrator.reviewFromContext = async () => ({
      success: true,
      pluginFailed: false,
      mechanicalFailedOnly: false,
      builtIn: { success: true, checks: [], totalDurationMs: 0 },
    }) as any;

    const result = await reviewStage.execute(ctx);

    reviewOrchestrator.reviewFromContext = original;

    expect(reReviewCalled).toBe(false);
    expect(result.action).toBe("continue");
  });

  // AC10: first-run branch — review() not called when skipLLMReviewers=true
  test("does not call reviewerSession.review() when skipLLMReviewers=true (AC10)", async () => {
    let reviewCalled = false;

    const { reviewOrchestrator } = await import("../../../../src/review/orchestrator");
    const original = reviewOrchestrator.reviewFromContext;
    reviewOrchestrator.reviewFromContext = async () => ({
      success: true,
      pluginFailed: false,
      mechanicalFailedOnly: false,
      builtIn: { success: true, checks: [], totalDurationMs: 0 },
    }) as any;

    // Mock createReviewerSession to capture if review() is called
    const originalCreate = _reviewDeps.createReviewerSession;
    _reviewDeps.createReviewerSession = (() => {
      return makeReviewerSession({
        review: async () => {
          reviewCalled = true;
          return { checkResult: { success: true, findings: [] }, cost: 0 };
        },
      });
    }) as any;

    const config = makeDialogueConfig();
    // add semanticConfig so the review() branch would fire without skipLLMReviewers
    (config.review as any).semantic = { enabled: true };

    // biome-ignore lint/suspicious/noExplicitAny: test-only — agentManager/sessionManager are in DispatchContext
    const ctx = makeCtx({
      config,
      skipLLMReviewers: true,
      agentManager: {} as any,
      sessionManager: {} as any,
    } as any);

    const result = await reviewStage.execute(ctx);

    reviewOrchestrator.reviewFromContext = original;
    _reviewDeps.createReviewerSession = originalCreate;

    expect(reviewCalled).toBe(false);
    expect(result.action).toBe("continue");
  });

  // AC11: when skipLLMReviewers is unset, dialogue branches execute normally
  test("calls reviewerSession.reReview() when skipLLMReviewers is unset (AC11)", async () => {
    let reReviewCalled = false;
    const session = makeReviewerSession({
      reReview: async () => {
        reReviewCalled = true;
        return { checkResult: { success: true, findings: [] } };
      },
    });

    const ctx = makeCtx({
      config: makeDialogueConfig(),
      reviewerSession: session as any,
      // skipLLMReviewers not set
    });

    const result = await reviewStage.execute(ctx);

    expect(reReviewCalled).toBe(true);
    expect(result.action).toBe("continue");
  });

  // AC11: when skipLLMReviewers=false, dialogue branches execute normally
  test("calls reviewerSession.reReview() when skipLLMReviewers=false (AC11)", async () => {
    let reReviewCalled = false;
    const session = makeReviewerSession({
      reReview: async () => {
        reReviewCalled = true;
        return { checkResult: { success: true, findings: [] } };
      },
    });

    const ctx = makeCtx({
      config: makeDialogueConfig(),
      reviewerSession: session as any,
      skipLLMReviewers: false,
    });

    const result = await reviewStage.execute(ctx);

    expect(reReviewCalled).toBe(true);
    expect(result.action).toBe("continue");
  });

  // AC12: debate+dialogue with skipLLMReviewers=true reaches orchestrator path (no extra check needed)
  test("reaches orchestrator path when reviewDebateEnabled=true and skipLLMReviewers=true (AC12)", async () => {
    let orchestratorCalled = false;
    const { reviewOrchestrator } = await import("../../../../src/review/orchestrator");
    const original = reviewOrchestrator.reviewFromContext;
    reviewOrchestrator.reviewFromContext = async () => {
      orchestratorCalled = true;
      return {
        success: true,
        pluginFailed: false,
        mechanicalFailedOnly: false,
        builtIn: { success: true, checks: [], totalDurationMs: 0 },
      } as any;
    };

    const config = makeDialogueConfig();
    // enable debate
    (config as any).debate = { enabled: true, stages: { review: { enabled: true } } };

    const ctx = makeCtx({
      rootConfig: {
        ...DEFAULT_CONFIG,
        debate: { enabled: true, stages: { review: { enabled: true } } },
      } as any,
      config,
      skipLLMReviewers: true,
      retrySkipChecks: new Set(["adversarial", "semantic"]),
    });

    const result = await reviewStage.execute(ctx);

    reviewOrchestrator.reviewFromContext = original;

    expect(orchestratorCalled).toBe(true);
    expect(result.action).toBe("continue");
  });
});
