/**
 * Metrics Tracker — RRP-002: initialComplexity in StoryMetrics
 *
 * AC-4: StoryMetrics gains initialComplexity?: string field
 * AC-5: collectStoryMetrics() reads story.routing.initialComplexity,
 *       falls back to routing.complexity for backward compat
 */

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { AgentFallbackRecord } from "@/agents/manager-types";
import type { NaxConfig } from "@/config";
import { collectStoryMetrics } from "@/metrics/tracker";
import type { PipelineContext } from "@/pipeline/types";
import type { PRD, UserStory } from "@/prd";
import type { StoryRouting } from "@/prd/types";
import { makeMockRuntime, makeNaxConfig, makeTestContext } from "@test/helpers";
// VerifyResult inlined after orchestrator-types.ts deletion (issue #1116).
interface VerifyResult {
  success: boolean;
  status: string;
  storyId: string;
  strategy: string;
  passCount: number;
  failCount: number;
  totalCount: number;
  failures: unknown[];
  durationMs: number;
  countsTowardEscalation: boolean;
  scopeTestFallback?: boolean;
}

const WORKDIR = `/tmp/nax-tracker-test-${randomUUID()}`;

// Students: put helpers in this file (do not import from ../../helpers)
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
  verifyResult?: VerifyResult,
): PipelineContext {
  const ctx = makeTestContext({
    config: makeNaxConfig(),
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
  });
  return Object.assign(ctx, {
    agentResult: {
      success: true,
      output: "",
      estimatedCostUsd: 0.01,
      durationMs: 5000,
    },
    verifyResult,
    runtime: makeMockRuntime(),
  });
}

// ---------------------------------------------------------------------------
// AC-5: collectStoryMetrics reads initialComplexity from story.routing
// ---------------------------------------------------------------------------

describe("collectStoryMetrics - initialComplexity field", () => {
  test("includes initialComplexity from story.routing.initialComplexity", async () => {
    const routing: StoryRouting = {
      complexity: "medium",
      initialComplexity: "simple", // original prediction before potential escalation
      testStrategy: "test-after",
      reasoning: "test",
    };
    const story = makeStory({ routing });
    const ctx = makeCtx(story, { complexity: "medium" });

    const metrics = await collectStoryMetrics(ctx, new Date().toISOString());

    expect(metrics.initialComplexity).toBe("simple");
  });

  test("initialComplexity differs from complexity when story was escalated", async () => {
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

    const metrics = await collectStoryMetrics(ctx, new Date().toISOString());

    expect(metrics.initialComplexity).toBe("simple");
    // complexity field unchanged (backward compat)
    expect(metrics.complexity).toBe("medium");
  });

  test("falls back to routing.complexity when story.routing.initialComplexity is absent", async () => {
    // Backward compat: story.routing exists but has no initialComplexity
    const routing: StoryRouting = {
      complexity: "complex",
      testStrategy: "three-session-tdd",
      reasoning: "legacy routing",
      // no initialComplexity
    };
    const story = makeStory({ routing });
    const ctx = makeCtx(story, { complexity: "complex" });

    const metrics = await collectStoryMetrics(ctx, new Date().toISOString());

    expect(metrics.initialComplexity).toBe("complex");
  });

  test("falls back to routing.complexity when story.routing is undefined", async () => {
    const story = makeStory({ routing: undefined });
    const ctx = makeCtx(story, { complexity: "simple" });

    const metrics = await collectStoryMetrics(ctx, new Date().toISOString());

    expect(metrics.initialComplexity).toBe("simple");
  });
});

// ---------------------------------------------------------------------------
// AC-4: StoryMetrics type has initialComplexity?: string
// ---------------------------------------------------------------------------

describe("StoryMetrics type - initialComplexity field", () => {
  test("StoryMetrics includes initialComplexity field", async () => {
    const routing: StoryRouting = {
      complexity: "medium",
      initialComplexity: "simple",
      testStrategy: "test-after",
      reasoning: "test",
    };
    const story = makeStory({ routing });
    const ctx = makeCtx(story, { complexity: "medium" });

    const metrics = await collectStoryMetrics(ctx, new Date().toISOString());

    // TypeScript will error at compile time if initialComplexity is not on StoryMetrics
    expect("initialComplexity" in metrics).toBe(true);
  });

  test("initialComplexity is a string when present", async () => {
    const routing: StoryRouting = {
      complexity: "expert",
      initialComplexity: "expert",
      testStrategy: "three-session-tdd",
      reasoning: "test",
    };
    const story = makeStory({ routing });
    const ctx = makeCtx(story, { complexity: "expert" });

    const metrics = await collectStoryMetrics(ctx, new Date().toISOString());

    expect(typeof metrics.initialComplexity).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// AC-4: collectStoryMetrics records agentUsed field
// ---------------------------------------------------------------------------

describe("collectStoryMetrics - agentUsed field", () => {
  test("agentUsed is defaultAgent when routing.agent is unset", async () => {
    const story = makeStory();
    const ctx = makeCtx(story, { modelTier: "balanced" });

    const metrics = await collectStoryMetrics(ctx, new Date().toISOString());

    expect(metrics.agentUsed).toBe("claude");
  });

  test("agentUsed is routing.agent when set", async () => {
    const story = makeStory();
    const ctx = makeCtx(story, { modelTier: "fast", agent: "codex" } as Partial<PipelineContext["routing"]>);

    const metrics = await collectStoryMetrics(ctx, new Date().toISOString());

    expect(metrics.agentUsed).toBe("codex");
  });

  test("agentUsed field exists on StoryMetrics", async () => {
    const story = makeStory();
    const ctx = makeCtx(story);

    const metrics = await collectStoryMetrics(ctx, new Date().toISOString());

    expect("agentUsed" in metrics).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-7: collectStoryMetrics reads ctx.agentResult.tokenUsage and sets tokens
// ---------------------------------------------------------------------------

describe("collectStoryMetrics - tokenUsage field", () => {
  test("sets storyMetrics.tokens when ctx.agentResult.tokenUsage is defined", async () => {
    const story = makeStory();
    const ctx = makeCtx(story, { modelTier: "balanced" });
    ctx.agentResult = {
      success: true,
      output: "",
      exitCode: 0,
      rateLimited: false,
      estimatedCostUsd: 0.01,
      durationMs: 5000,
      tokenUsage: {
        inputTokens: 1000,
        outputTokens: 500,
      },
    };

    const metrics = await collectStoryMetrics(ctx, new Date().toISOString());

    expect(metrics.tokens).toBeDefined();
    expect(metrics.tokens?.inputTokens).toBe(1000);
    expect(metrics.tokens?.outputTokens).toBe(500);
  });

  test("sets storyMetrics.tokens with cache fields when present in tokenUsage", async () => {
    const story = makeStory();
    const ctx = makeCtx(story, { modelTier: "balanced" });
    ctx.agentResult = {
      success: true,
      output: "",
      exitCode: 0,
      rateLimited: false,
      estimatedCostUsd: 0.01,
      durationMs: 5000,
      tokenUsage: {
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadInputTokens: 100,
        cacheCreationInputTokens: 50,
      },
    };

    const metrics = await collectStoryMetrics(ctx, new Date().toISOString());

    expect(metrics.tokens).toBeDefined();
    expect(metrics.tokens?.inputTokens).toBe(1000);
    expect(metrics.tokens?.outputTokens).toBe(500);
    expect(metrics.tokens?.cacheReadInputTokens).toBe(100);
    expect(metrics.tokens?.cacheCreationInputTokens).toBe(50);
  });

  test("storyMetrics.tokens is undefined when ctx.agentResult.tokenUsage is undefined", async () => {
    const story = makeStory();
    const ctx = makeCtx(story, { modelTier: "balanced" });
    ctx.agentResult = {
      success: true,
      output: "",
      exitCode: 0,
      rateLimited: false,
      estimatedCostUsd: 0.01,
      durationMs: 5000,
    };

    const metrics = await collectStoryMetrics(ctx, new Date().toISOString());

    expect(metrics.tokens).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// US-002: collectStoryMetrics propagates scopeTestFallback
// ---------------------------------------------------------------------------

describe("collectStoryMetrics - scopeTestFallback field (US-002)", () => {
  test("scopeTestFallback is absent from StoryMetrics when verifyResult does not have it", async () => {
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

    const metrics = await collectStoryMetrics(ctx, new Date().toISOString());

    expect(metrics.scopeTestFallback).toBeUndefined();
  });

  test("scopeTestFallback is absent from StoryMetrics when verifyResult is undefined", async () => {
    const story = makeStory();
    const ctx = makeCtx(story);

    const metrics = await collectStoryMetrics(ctx, new Date().toISOString());

    expect(metrics.scopeTestFallback).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC-41: collectStoryMetrics maps recorded agent-swap hops to StoryMetrics.fallback.
//
// Retargeted for nax#1707. These wrote ctx.agentFallbacks, a field nothing in
// src/ ever assigned — so they exercised the test's own write and passed while
// the metric was never emitted in production. The multi-hop case is kept here;
// the single-hop, empty and absent cases live in the #1707 block below.
// ---------------------------------------------------------------------------

describe("collectStoryMetrics - AC-41 fallback.hops field", () => {
  test("fallback.hops preserves all hop fields across a multi-hop swap chain", async () => {
    const story = makeStory();
    const ctx = makeCtx(story);
    ctx.runtime.agentFallbacks.set(story.id, [
      {
        storyId: "US-001",
        priorAgent: "claude",
        newAgent: "codex",
        outcome: "fail-service-down",
        category: "availability",
        hop: 1,
        timestamp: "2026-08-25T00:00:00.000Z",
        costUsd: 0,
      },
      {
        storyId: "US-001",
        priorAgent: "codex",
        newAgent: "opencode",
        outcome: "fail-rate-limit",
        category: "availability",
        hop: 2,
        timestamp: "2026-08-25T00:00:01.000Z",
        costUsd: 1.5,
      },
    ]);

    const metrics = await collectStoryMetrics(ctx, new Date().toISOString());

    expect(metrics.fallback?.hops).toHaveLength(2);
    expect(metrics.fallback?.hops[0].priorAgent).toBe("claude");
    expect(metrics.fallback?.hops[0].newAgent).toBe("codex");
    expect(metrics.fallback?.hops[1].hop).toBe(2);
    expect(metrics.fallback?.hops[1].category).toBe("availability");
    expect(metrics.fallback?.hops[1].costUsd).toBe(1.5);
  });
});

// ---------------------------------------------------------------------------
// nax#1707: the hops AgentManager records reach metrics via the run-scoped
// runtime.agentFallbacks store that callOp writes — not via ctx.agentFallbacks
// (which had no writer) nor via ctx.agentResult (which post-run.ts rebuilds
// without them). These assert the store is what collectStoryMetrics reads.
// ---------------------------------------------------------------------------

describe("collectStoryMetrics - #1707 agent-swap hops come from the run-scoped store", () => {
  function ctxWithRecordedHops(records: AgentFallbackRecord[]): PipelineContext {
    const story = makeStory();
    const ctx = makeCtx(story);
    if (records.length > 0) ctx.runtime.agentFallbacks.set(story.id, records);
    return ctx;
  }

  test("surfaces hops that callOp recorded on runtime.agentFallbacks", async () => {
    const ctx = ctxWithRecordedHops([
      {
        storyId: "US-001",
        priorAgent: "claude",
        newAgent: "codex",
        hop: 1,
        outcome: "fail-quota",
        category: "availability",
        timestamp: "2026-08-25T00:00:00.000Z",
        costUsd: 0.42,
      },
    ]);

    const metrics = await collectStoryMetrics(ctx, new Date().toISOString());

    expect(metrics.fallback).toBeDefined();
    expect(metrics.fallback?.hops).toHaveLength(1);
    expect(metrics.fallback?.hops[0]).toEqual({
      storyId: "US-001",
      priorAgent: "claude",
      newAgent: "codex",
      hop: 1,
      outcome: "fail-quota",
      category: "availability",
      costUsd: 0.42,
    });
  });

  test("fills storyId from the story under execution when the record omits it", async () => {
    const ctx = ctxWithRecordedHops([
      {
        priorAgent: "claude",
        newAgent: "codex",
        hop: 1,
        outcome: "fail-rate-limit",
        category: "availability",
        timestamp: "2026-08-25T00:00:00.000Z",
        costUsd: 0,
      },
    ]);

    const metrics = await collectStoryMetrics(ctx, new Date().toISOString());

    expect(metrics.fallback?.hops[0].storyId).toBe(ctx.story.id);
  });

  test("omits fallback entirely when the agent ran with no swaps", async () => {
    const ctx = ctxWithRecordedHops([]);

    const metrics = await collectStoryMetrics(ctx, new Date().toISOString());

    expect(metrics.fallback).toBeUndefined();
  });
});
