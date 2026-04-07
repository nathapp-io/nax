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
import { DEFAULT_CONFIG } from "../../../../src/config";
import type { NaxConfig } from "../../../../src/config";
import { InteractionChain } from "../../../../src/interaction/chain";
import type { InteractionPlugin, InteractionResponse } from "../../../../src/interaction/types";
import { _reviewDeps, reviewStage } from "../../../../src/pipeline/stages/review";
import type { PipelineContext } from "../../../../src/pipeline/types";
import type { PRD, UserStory } from "../../../../src/prd";
import type { ReviewFinding } from "../../../../src/plugins/extensions";

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

function makeConfig(triggers: Record<string, unknown>): NaxConfig {
  return {
    review: { enabled: true },
    interaction: {
      plugin: "cli",
      defaults: { timeout: 30000, fallback: "abort" as const },
      triggers,
    },
  } as unknown as NaxConfig;
}

function makeStory(overrides?: Partial<UserStory>): UserStory {
  return {
    id: "US-001",
    title: "Test Story",
    description: "Test",
    acceptanceCriteria: [],
    tags: [],
    dependencies: [],
    status: "in-progress",
    passes: false,
    escalations: [],
    attempts: 1,
    ...overrides,
  };
}

function makePRD(): PRD {
  return {
    project: "test",
    feature: "my-feature",
    branchName: "test-branch",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: [makeStory()],
  };
}

function makeCtx(overrides: Partial<PipelineContext>): PipelineContext {
  return {
    config: makeConfig({}),
    prd: makePRD(),
    story: makeStory(),
    stories: [makeStory()],
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

    const config = makeConfig({});
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

    const config = makeConfig({});
    config.review.pluginMode = "deferred";
    const ctx = makeCtx({ config });
    await reviewStage.execute(ctx);

    const calledConfig = orchestratorMock.mock.calls[0]?.[0];
    expect(calledConfig?.pluginMode).toBe("deferred");
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

    const config = makeConfig({});
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

    const ctx = makeCtx({ config: makeConfig({}) });
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
      config: makeConfig({ "security-review": { enabled: true } }),
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
      config: makeConfig({ "security-review": { enabled: true } }),
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
      config: makeConfig({ "security-review": { enabled: true } }),
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
      config: makeConfig({ "security-review": { enabled: true } }),
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
    const semanticFindings: ReviewFinding[] = [
      {
        ruleId: "semantic",
        severity: "error",
        file: "src/review/runner.ts",
        line: 42,
        message: "Missing wiring",
        source: "semantic-review",
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
  test("ctx.reviewFindings contains findings with source='semantic-review' and ruleId='semantic'", async () => {
    const semanticFindings: ReviewFinding[] = [
      {
        ruleId: "semantic",
        severity: "error",
        file: "src/foo.ts",
        line: 10,
        message: "Stub left in code",
        source: "semantic-review",
      },
      {
        ruleId: "semantic",
        severity: "warning",
        file: "src/bar.ts",
        line: 25,
        message: "TODO not addressed",
        source: "semantic-review",
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
      expect(f.ruleId).toBe("semantic");
    }
    expect(ctx.reviewFindings![0].file).toBe("src/foo.ts");
    expect(ctx.reviewFindings![0].line).toBe(10);
    expect(ctx.reviewFindings![0].message).toBe("Stub left in code");
    reviewOrchestrator.review = original;
  });

  // AC-3: findings structured for priorFailures context (source/ruleId match context renderer expectations)
  test("ctx.reviewFindings has source='semantic-review' so context renderer includes tool source in retry context", async () => {
    const semanticFindings: ReviewFinding[] = [
      { ruleId: "semantic", severity: "error", file: "src/a.ts", line: 1, message: "Critical issue", source: "semantic-review" },
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
    expect(ctx.reviewFindings![0].ruleId).toBe("semantic");
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
    const semanticFindings: ReviewFinding[] = [
      { ruleId: "semantic", severity: "error", file: "src/a.ts", line: 1, message: "Issue", source: "semantic-review" },
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
