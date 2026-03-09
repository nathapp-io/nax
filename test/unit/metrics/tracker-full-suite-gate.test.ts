/**
 * Metrics Tracker — RL-005: Track fullSuiteGatePassed per story
 *
 * AC-1: fullSuiteGatePassed is tracked in PipelineContext (field already exists)
 * AC-2: Flag is saved to PRD/metrics — StoryMetrics gains fullSuiteGatePassed field,
 *       collectStoryMetrics() reads ctx.fullSuiteGatePassed
 * AC-3: test-after and tdd-simple strategies always produce fullSuiteGatePassed: false
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";
import type { NaxConfig } from "../../../src/config";
import type { PipelineContext } from "../../../src/pipeline/types";
import type { PRD, UserStory } from "../../../src/prd";
import { collectBatchMetrics, collectStoryMetrics } from "../../../src/metrics/tracker";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStory(overrides?: Partial<UserStory>): UserStory {
  return {
    id: "US-001",
    title: "Test Story",
    description: "Test description",
    acceptanceCriteria: [],
    tags: [],
    dependencies: [],
    status: "passed",
    passes: true,
    escalations: [],
    attempts: 1,
    ...overrides,
  };
}

function makePRD(story: UserStory): PRD {
  return {
    project: "test-project",
    feature: "test-feature",
    branchName: "feat/test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: [story],
  };
}

function makeCtx(
  story: UserStory,
  routingOverrides?: Partial<PipelineContext["routing"]>,
  ctxOverrides?: Partial<PipelineContext>,
): PipelineContext {
  return {
    config: { ...DEFAULT_CONFIG } as NaxConfig,
    prd: makePRD(story),
    story,
    stories: [story],
    routing: {
      complexity: "medium",
      modelTier: "balanced",
      testStrategy: "three-session-tdd",
      reasoning: "test",
      ...routingOverrides,
    },
    workdir: "/tmp/nax-tracker-gate-test",
    hooks: { hooks: {} },
    agentResult: {
      success: true,
      output: "",
      estimatedCost: 0.01,
      durationMs: 5000,
    },
    ...ctxOverrides,
  } as unknown as PipelineContext;
}

// ---------------------------------------------------------------------------
// AC-2: StoryMetrics type has fullSuiteGatePassed field
// ---------------------------------------------------------------------------

describe("StoryMetrics type - fullSuiteGatePassed field", () => {
  test("StoryMetrics includes fullSuiteGatePassed field", () => {
    const story = makeStory();
    const ctx = makeCtx(story, { testStrategy: "three-session-tdd" }, { fullSuiteGatePassed: true });

    const metrics = collectStoryMetrics(ctx, new Date().toISOString());

    expect("fullSuiteGatePassed" in metrics).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-2: collectStoryMetrics reads ctx.fullSuiteGatePassed
// ---------------------------------------------------------------------------

describe("collectStoryMetrics - fullSuiteGatePassed for TDD strategies", () => {
  test("returns true for three-session-tdd when ctx.fullSuiteGatePassed is true", () => {
    const story = makeStory();
    const ctx = makeCtx(story, { testStrategy: "three-session-tdd" }, { fullSuiteGatePassed: true });

    const metrics = collectStoryMetrics(ctx, new Date().toISOString());

    expect(metrics.fullSuiteGatePassed).toBe(true);
  });

  test("returns true for three-session-tdd-lite when ctx.fullSuiteGatePassed is true", () => {
    const story = makeStory();
    const ctx = makeCtx(story, { testStrategy: "three-session-tdd-lite" }, { fullSuiteGatePassed: true });

    const metrics = collectStoryMetrics(ctx, new Date().toISOString());

    expect(metrics.fullSuiteGatePassed).toBe(true);
  });

  test("returns false for three-session-tdd when ctx.fullSuiteGatePassed is false", () => {
    const story = makeStory();
    const ctx = makeCtx(story, { testStrategy: "three-session-tdd" }, { fullSuiteGatePassed: false });

    const metrics = collectStoryMetrics(ctx, new Date().toISOString());

    expect(metrics.fullSuiteGatePassed).toBe(false);
  });

  test("returns false for three-session-tdd when ctx.fullSuiteGatePassed is undefined", () => {
    const story = makeStory();
    const ctx = makeCtx(story, { testStrategy: "three-session-tdd" });
    // fullSuiteGatePassed not set in ctx

    const metrics = collectStoryMetrics(ctx, new Date().toISOString());

    expect(metrics.fullSuiteGatePassed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC-3: test-after and tdd-simple always produce fullSuiteGatePassed: false
// ---------------------------------------------------------------------------

describe("collectStoryMetrics - fullSuiteGatePassed always false for non-TDD strategies", () => {
  test("returns false for test-after even when ctx.fullSuiteGatePassed is true", () => {
    const story = makeStory();
    const ctx = makeCtx(story, { testStrategy: "test-after" }, { fullSuiteGatePassed: true });

    const metrics = collectStoryMetrics(ctx, new Date().toISOString());

    expect(metrics.fullSuiteGatePassed).toBe(false);
  });

  test("returns false for tdd-simple even when ctx.fullSuiteGatePassed is true", () => {
    const story = makeStory();
    const ctx = makeCtx(story, { testStrategy: "tdd-simple" }, { fullSuiteGatePassed: true });

    const metrics = collectStoryMetrics(ctx, new Date().toISOString());

    expect(metrics.fullSuiteGatePassed).toBe(false);
  });

  test("returns false for test-after when ctx.fullSuiteGatePassed is false", () => {
    const story = makeStory();
    const ctx = makeCtx(story, { testStrategy: "test-after" }, { fullSuiteGatePassed: false });

    const metrics = collectStoryMetrics(ctx, new Date().toISOString());

    expect(metrics.fullSuiteGatePassed).toBe(false);
  });

  test("returns false for tdd-simple when ctx.fullSuiteGatePassed is false", () => {
    const story = makeStory();
    const ctx = makeCtx(story, { testStrategy: "tdd-simple" }, { fullSuiteGatePassed: false });

    const metrics = collectStoryMetrics(ctx, new Date().toISOString());

    expect(metrics.fullSuiteGatePassed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Batch metrics: fullSuiteGatePassed always false (batches are not TDD-gated)
// ---------------------------------------------------------------------------

describe("collectBatchMetrics - fullSuiteGatePassed always false", () => {
  test("batch metrics always have fullSuiteGatePassed: false", () => {
    const story1 = makeStory({ id: "US-001" });
    const story2 = makeStory({ id: "US-002" });
    const prd: PRD = {
      project: "test-project",
      feature: "test-feature",
      branchName: "feat/test",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userStories: [story1, story2],
    };
    const ctx = {
      config: { ...DEFAULT_CONFIG } as NaxConfig,
      prd,
      story: story1,
      stories: [story1, story2],
      routing: {
        complexity: "medium",
        modelTier: "balanced",
        testStrategy: "three-session-tdd",
        reasoning: "test",
      },
      workdir: "/tmp/nax-tracker-gate-test",
      hooks: { hooks: {} },
      agentResult: {
        success: true,
        output: "",
        estimatedCost: 0.02,
        durationMs: 10000,
      },
      fullSuiteGatePassed: true,
    } as unknown as PipelineContext;

    const metrics = collectBatchMetrics(ctx, new Date().toISOString());

    for (const m of metrics) {
      expect(m.fullSuiteGatePassed).toBe(false);
    }
  });
});
