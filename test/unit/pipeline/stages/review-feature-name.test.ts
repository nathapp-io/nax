/**
 * Unit tests for featureName threading in review pipeline stage (US-002 AC-4)
 *
 * Tests cover:
 * - AC-4: review stage passes ctx.prd.feature as featureName to reviewOrchestrator.review()
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import type { NaxConfig } from "../../../../src/config";
import { reviewStage } from "../../../../src/pipeline/stages/review";
import type { PipelineContext } from "../../../../src/pipeline/types";
import type { PRD, UserStory } from "../../../../src/prd";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeConfig(): NaxConfig {
  return {
    review: { enabled: true, checks: [], commands: {} },
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

function makePRD(feature = "my-feature"): PRD {
  return {
    project: "test-project",
    feature,
    branchName: "feat/test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: [makeStory()],
  };
}

function makeCtx(overrides: Partial<PipelineContext>): PipelineContext {
  return {
    config: makeConfig(),
    prd: makePRD(),
    story: makeStory(),
    stories: [makeStory()],
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    workdir: "/tmp/test",
    hooks: {} as PipelineContext["hooks"],
    ...overrides,
  } as unknown as PipelineContext;
}

// ─────────────────────────────────────────────────────────────────────────────
// AC-4: review stage passes ctx.prd.feature as featureName
// ─────────────────────────────────────────────────────────────────────────────

describe("reviewStage — passes ctx.prd.feature as featureName (US-002 AC-4)", () => {
  afterEach(() => {
    mock.restore();
  });

  test("passes ctx.prd.feature as featureName to reviewOrchestrator.review", async () => {
    const capturedArgs: unknown[][] = [];
    const { reviewOrchestrator } = await import("../../../../src/review/orchestrator");
    const original = reviewOrchestrator.review;

    reviewOrchestrator.review = mock(async (...args: unknown[]) => {
      capturedArgs.push(args);
      return { success: true, pluginFailed: false, builtIn: { totalDurationMs: 0 } };
    }) as typeof reviewOrchestrator.review;

    const ctx = makeCtx({ prd: makePRD("my-feature") });
    await reviewStage.execute(ctx);

    expect(capturedArgs).toHaveLength(1);
    // featureName is the last positional arg — it should be "my-feature"
    // ReviewOrchestrator.review(..., retrySkipChecks, featureName)
    const args = capturedArgs[0] as unknown[];
    const featureNameArg = args[args.length - 1];
    expect(featureNameArg).toBe("my-feature");

    reviewOrchestrator.review = original;
  });

  test("passes ctx.prd.feature when feature name contains hyphens and spaces", async () => {
    const capturedArgs: unknown[][] = [];
    const { reviewOrchestrator } = await import("../../../../src/review/orchestrator");
    const original = reviewOrchestrator.review;

    reviewOrchestrator.review = mock(async (...args: unknown[]) => {
      capturedArgs.push(args);
      return { success: true, pluginFailed: false, builtIn: { totalDurationMs: 0 } };
    }) as typeof reviewOrchestrator.review;

    const ctx = makeCtx({ prd: makePRD("semantic-session-continuity") });
    await reviewStage.execute(ctx);

    const args = capturedArgs[0] as unknown[];
    const featureNameArg = args[args.length - 1];
    expect(featureNameArg).toBe("semantic-session-continuity");

    reviewOrchestrator.review = original;
  });

  test("does not pass undefined when prd.feature is set", async () => {
    const capturedArgs: unknown[][] = [];
    const { reviewOrchestrator } = await import("../../../../src/review/orchestrator");
    const original = reviewOrchestrator.review;

    reviewOrchestrator.review = mock(async (...args: unknown[]) => {
      capturedArgs.push(args);
      return { success: true, pluginFailed: false, builtIn: { totalDurationMs: 0 } };
    }) as typeof reviewOrchestrator.review;

    const ctx = makeCtx({ prd: makePRD("active-feature") });
    await reviewStage.execute(ctx);

    const args = capturedArgs[0] as unknown[];
    const featureNameArg = args[args.length - 1];
    // When prd.feature is set, featureName must not be undefined
    expect(featureNameArg).not.toBeUndefined();
    expect(featureNameArg).toBe("active-feature");

    reviewOrchestrator.review = original;
  });
});
