/**
 * Routing Stage — ADR-025: initialModelTier written on first classify, never overwritten
 *
 * AC-1: StoryRouting interface gains initialModelTier?: ModelTier field
 * AC-2: Routing stage writes initialModelTier when story.routing is first created
 * AC-3: Escalation path never overwrites initialModelTier
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { makeNaxConfig, makeStory } from "@test/helpers";
import { DEFAULT_CONFIG } from "@/config";
import type { _routingDeps as RoutingDeps } from "@/pipeline/stages/routing";
import type { PipelineContext } from "@/pipeline/types";
import type { PRD, UserStory } from "@/prd";
import type { EscalationAttempt, StoryRouting } from "@/prd/types";

const WORKDIR = `/tmp/nax-routing-initial-model-tier-test-${randomUUID()}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function makeCtx(story: UserStory, overrides?: Partial<PipelineContext>): PipelineContext & { prdPath: string } {
  const prd = makePRD(story);
  return {
    config: makeNaxConfig({ tdd: { greenfieldDetection: false } }),
    prd,
    story,
    stories: [story],
    routing: {
      complexity: "simple",
      modelTier: "fast",
      testStrategy: "test-after",
      reasoning: "test",
    },
    rootConfig: DEFAULT_CONFIG,
    workdir: WORKDIR,
    projectDir: WORKDIR,
    hooks: { hooks: {} },
    prdPath: `${WORKDIR}/nax/prd.json`,
    ...overrides,
  } as PipelineContext & { prdPath: string };
}

const FAST_ROUTING_RESULT = {
  complexity: "simple" as const,
  modelTier: "fast" as const,
  testStrategy: "test-after" as const,
  reasoning: "x",
};

// ---------------------------------------------------------------------------
// AC-2: initialModelTier written on first classify (story.routing undefined)
// ---------------------------------------------------------------------------

describe("routingStage - initialModelTier set on first classification", () => {
  let origRoutingDeps: typeof RoutingDeps;

  afterEach(() => {
    mock.restore();
    if (origRoutingDeps) {
      const { _routingDeps } = require("@/pipeline/stages/routing");
      Object.assign(_routingDeps, origRoutingDeps);
    }
  });

  test("story.routing.initialModelTier is set to classified modelTier on first classify", async () => {
    const { routingStage, _routingDeps } = await import("@/pipeline/stages/routing");

    origRoutingDeps = { ..._routingDeps };

    _routingDeps.resolveRouting = mock(() => Promise.resolve({ ...FAST_ROUTING_RESULT }));
    _routingDeps.isGreenfieldStory = mock(() => Promise.resolve(false));
    _routingDeps.savePRD = mock(() => Promise.resolve());

    const story = makeStory({ routing: undefined });
    const ctx = makeCtx(story);

    await routingStage.execute(ctx as Parameters<typeof routingStage.execute>[0]);

    expect(ctx.story.routing?.initialModelTier).toBe("fast");
  });

  test("story.routing.initialModelTier matches modelTier on first classify (powerful tier)", async () => {
    const { routingStage, _routingDeps } = await import("@/pipeline/stages/routing");

    origRoutingDeps = { ..._routingDeps };

    _routingDeps.resolveRouting = mock(() =>
      Promise.resolve({
        complexity: "expert" as const,
        modelTier: "powerful" as const,
        testStrategy: "three-session-tdd" as const,
        reasoning: "complex feature",
      }),
    );
    _routingDeps.isGreenfieldStory = mock(() => Promise.resolve(false));
    _routingDeps.savePRD = mock(() => Promise.resolve());

    const story = makeStory({ routing: undefined });
    const ctx = makeCtx(story);

    await routingStage.execute(ctx as Parameters<typeof routingStage.execute>[0]);

    expect(ctx.story.routing?.initialModelTier).toBe("powerful");
    expect(ctx.story.routing?.modelTier).toBe("powerful");
  });
});

// ---------------------------------------------------------------------------
// AC-3: Escalation path never overwrites initialModelTier
// ---------------------------------------------------------------------------

describe("routingStage - initialModelTier never overwritten after first classify", () => {
  let origRoutingDeps: typeof RoutingDeps;

  afterEach(() => {
    mock.restore();
    if (origRoutingDeps) {
      const { _routingDeps } = require("@/pipeline/stages/routing");
      Object.assign(_routingDeps, origRoutingDeps);
    }
  });

  test("initialModelTier is preserved when story escalates from fast to powerful", async () => {
    const { routingStage, _routingDeps } = await import("@/pipeline/stages/routing");

    origRoutingDeps = { ..._routingDeps };

    // First run: story gets routed to "fast"
    _routingDeps.resolveRouting = mock(() => Promise.resolve({ ...FAST_ROUTING_RESULT }));
    _routingDeps.isGreenfieldStory = mock(() => Promise.resolve(false));
    _routingDeps.savePRD = mock(() => Promise.resolve());

    const story = makeStory({ routing: undefined });
    const ctx = makeCtx(story);

    await routingStage.execute(ctx as Parameters<typeof routingStage.execute>[0]);

    // Verify initialModelTier was set on first classify
    expect(ctx.story.routing?.initialModelTier).toBe("fast");

    // Simulate escalation: add an escalation record and bump tier
    const escalation: EscalationAttempt = {
      fromTier: "fast",
      toTier: "powerful",
      reason: "failed",
      timestamp: new Date().toISOString(),
    };
    ctx.story.escalations = [escalation];
    if (ctx.story.routing) {
      ctx.story.routing = { ...ctx.story.routing, modelTier: "powerful" };
    }

    // Second run (after escalation): resolveRouting may return a different tier
    _routingDeps.resolveRouting = mock(() =>
      Promise.resolve({
        complexity: "simple" as const,
        modelTier: "balanced" as const,
        testStrategy: "test-after" as const,
        reasoning: "re-classified",
      }),
    );

    await routingStage.execute(ctx as Parameters<typeof routingStage.execute>[0]);

    // initialModelTier must still be "fast" — not overwritten by escalation
    expect(ctx.story.routing?.initialModelTier).toBe("fast");
    // modelTier is the escalated "powerful" (preserved because escalation record exists)
    expect(ctx.story.routing?.modelTier).toBe("powerful");
  });
});

// ---------------------------------------------------------------------------
// AC-1: StoryRouting interface exposes initialModelTier field
// ---------------------------------------------------------------------------

describe("StoryRouting - initialModelTier field exists on type", () => {
  test("StoryRouting accepts initialModelTier as optional ModelTier field", () => {
    const routing: StoryRouting = {
      complexity: "simple",
      testStrategy: "test-after",
      reasoning: "test",
      initialModelTier: "fast",
    };
    expect(routing.initialModelTier).toBe("fast");
  });

  test("StoryRouting is valid without initialModelTier (optional field)", () => {
    const routing: StoryRouting = {
      complexity: "simple",
      testStrategy: "test-after",
      reasoning: "test",
    };
    expect(routing.initialModelTier).toBeUndefined();
  });
});
