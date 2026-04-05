/**
 * Metrics Tracker — RRP-002: initialComplexity in StoryMetrics
 *
 * AC-4: StoryMetrics gains initialComplexity?: string field
 * AC-5: collectStoryMetrics() reads story.routing.initialComplexity,
 *       falls back to routing.complexity for backward compat
 */

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { NaxConfig } from "../../../src/config";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";
import { collectStoryMetrics } from "../../../src/metrics/tracker";
import type { PipelineContext } from "../../../src/pipeline/types";
import type { PRD, UserStory } from "../../../src/prd";
import type { StoryRouting } from "../../../src/prd/types";
import type { VerifyResult } from "../../../src/verification/orchestrator-types";

const WORKDIR = `/tmp/nax-tracker-test-${randomUUID()}`;

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

function makeConfig(): NaxConfig {
  return { ...DEFAULT_CONFIG };
}

function makeCtx(
  story: UserStory,
  routingOverrides?: Partial<PipelineContext["routing"]>,
  verifyResult?: VerifyResult,
): PipelineContext {
  return {
    config: makeConfig(),
    prd: makePRD(story),
    story,
    stories: [story],
    routing: {
      complexity: "medium",
      modelTier: "balanced",
      testStrategy: "test-after",
      reasoning: "test",
      ...routingOverrides,
    },
    workdir: WORKDIR,
    hooks: { hooks: {} },
    agentResult: {
      success: true,
      output: "",
      estimatedCost: 0.01,
      durationMs: 5000,
    },
    verifyResult,
  } as unknown as PipelineContext;
}

// ---------------------------------------------------------------------------
// AC-5: collectStoryMetrics reads initialComplexity from story.routing
// ---------------------------------------------------------------------------

describe("collectStoryMetrics - initialComplexity field", () => {
  test("includes initialComplexity from story.routing.initialComplexity", () => {
    const routing: StoryRouting = {
      complexity: "medium",
      initialComplexity: "simple", // original prediction before potential escalation
      testStrategy: "test-after",
      reasoning: "test",
    };
    const story = makeStory({ routing });
    const ctx = makeCtx(story, { complexity: "medium" });

    const metrics = collectStoryMetrics(ctx, new Date().toISOString());

    expect(metrics.initialComplexity).toBe("simple");
  });

  test("initialComplexity differs from complexity when story was escalated", () => {
    const routing: StoryRouting = {
      complexity: "medium", // complexity as classified
      initialComplexity: "simple", // original first-classify prediction
      modelTier: "powerful", // escalated tier
      testStrategy: "three-session-tdd",
      reasoning: "escalated",
    };
    const story = makeStory({
      routing,
      escalations: [
        {
          fromTier: "balanced",
          toTier: "powerful",
          reason: "test failure",
          timestamp: new Date().toISOString(),
        },
      ],
      attempts: 2,
    });
    const ctx = makeCtx(story, { complexity: "medium", modelTier: "balanced" });

    const metrics = collectStoryMetrics(ctx, new Date().toISOString());

    expect(metrics.initialComplexity).toBe("simple");
    // complexity field unchanged (backward compat)
    expect(metrics.complexity).toBe("medium");
  });

  test("falls back to routing.complexity when story.routing.initialComplexity is absent", () => {
    // Backward compat: story.routing exists but has no initialComplexity
    const routing: StoryRouting = {
      complexity: "complex",
      testStrategy: "three-session-tdd",
      reasoning: "legacy routing",
      // no initialComplexity
    };
    const story = makeStory({ routing });
    const ctx = makeCtx(story, { complexity: "complex" });

    const metrics = collectStoryMetrics(ctx, new Date().toISOString());

    expect(metrics.initialComplexity).toBe("complex");
  });

  test("falls back to routing.complexity when story.routing is undefined", () => {
    const story = makeStory({ routing: undefined });
    const ctx = makeCtx(story, { complexity: "simple" });

    const metrics = collectStoryMetrics(ctx, new Date().toISOString());

    expect(metrics.initialComplexity).toBe("simple");
  });
});

// ---------------------------------------------------------------------------
// AC-4: StoryMetrics type has initialComplexity?: string
// ---------------------------------------------------------------------------

describe("StoryMetrics type - initialComplexity field", () => {
  test("StoryMetrics includes initialComplexity field", () => {
    const routing: StoryRouting = {
      complexity: "medium",
      initialComplexity: "simple",
      testStrategy: "test-after",
      reasoning: "test",
    };
    const story = makeStory({ routing });
    const ctx = makeCtx(story, { complexity: "medium" });

    const metrics = collectStoryMetrics(ctx, new Date().toISOString());

    // TypeScript will error at compile time if initialComplexity is not on StoryMetrics
    expect("initialComplexity" in metrics).toBe(true);
  });

  test("initialComplexity is a string when present", () => {
    const routing: StoryRouting = {
      complexity: "expert",
      initialComplexity: "expert",
      testStrategy: "three-session-tdd",
      reasoning: "test",
    };
    const story = makeStory({ routing });
    const ctx = makeCtx(story, { complexity: "expert" });

    const metrics = collectStoryMetrics(ctx, new Date().toISOString());

    expect(typeof metrics.initialComplexity).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// AC-4: collectStoryMetrics records agentUsed field
// ---------------------------------------------------------------------------

describe("collectStoryMetrics - agentUsed field", () => {
  test("agentUsed is defaultAgent when routing.agent is unset", () => {
    const story = makeStory();
    const ctx = makeCtx(story, { modelTier: "balanced" });

    const metrics = collectStoryMetrics(ctx, new Date().toISOString());

    expect(metrics.agentUsed).toBe("claude");
  });

  test("agentUsed is routing.agent when set", () => {
    const story = makeStory();
    const ctx = makeCtx(story, { modelTier: "fast", agent: "codex" } as Partial<PipelineContext["routing"]>);

    const metrics = collectStoryMetrics(ctx, new Date().toISOString());

    expect(metrics.agentUsed).toBe("codex");
  });

  test("agentUsed field exists on StoryMetrics", () => {
    const story = makeStory();
    const ctx = makeCtx(story);

    const metrics = collectStoryMetrics(ctx, new Date().toISOString());

    expect("agentUsed" in metrics).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// US-002: collectStoryMetrics propagates scopeTestFallback
// ---------------------------------------------------------------------------

describe("collectStoryMetrics - scopeTestFallback field (US-002)", () => {
  test("scopeTestFallback is propagated from verifyResult to StoryMetrics when set", () => {
    const story = makeStory();
    const verifyResult: VerifyResult = {
      success: true,
      status: "PASS",
      storyId: story.id,
      strategy: "scoped",
      passCount: 10,
      failCount: 0,
      totalCount: 10,
      failures: [],
      durationMs: 5000,
      countsTowardEscalation: false,
      scopeTestFallback: true,
    };
    const ctx = makeCtx(story, {}, verifyResult);

    const metrics = collectStoryMetrics(ctx, new Date().toISOString());

    expect(metrics.scopeTestFallback).toBe(true);
  });

  test("scopeTestFallback is absent from StoryMetrics when verifyResult does not have it", () => {
    const story = makeStory();
    const verifyResult: VerifyResult = {
      success: true,
      status: "PASS",
      storyId: story.id,
      strategy: "scoped",
      passCount: 10,
      failCount: 0,
      totalCount: 10,
      failures: [],
      durationMs: 5000,
      countsTowardEscalation: false,
    };
    const ctx = makeCtx(story, {}, verifyResult);

    const metrics = collectStoryMetrics(ctx, new Date().toISOString());

    expect(metrics.scopeTestFallback).toBeUndefined();
  });

  test("scopeTestFallback is absent from StoryMetrics when verifyResult is undefined", () => {
    const story = makeStory();
    const ctx = makeCtx(story);

    const metrics = collectStoryMetrics(ctx, new Date().toISOString());

    expect(metrics.scopeTestFallback).toBeUndefined();
  });
});
