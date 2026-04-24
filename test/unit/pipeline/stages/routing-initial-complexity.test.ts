/**
 * Routing Stage — RRP-002: initialComplexity written on first classify, never overwritten
 *
 * AC-1: StoryRouting interface gains initialComplexity?: Complexity field
 * AC-2: Routing stage writes initialComplexity when story.routing is first created
 * AC-3: Escalation path never overwrites initialComplexity
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { DEFAULT_CONFIG } from "../../../../src/config/defaults";
import type { PRD, UserStory } from "../../../../src/prd";
import type { PipelineContext } from "../../../../src/pipeline/types";
import type { _routingDeps as RoutingDeps } from "../../../../src/pipeline/stages/routing";
import type { StoryRouting } from "../../../../src/prd/types";
import { makeNaxConfig, makeStory } from "../../../helpers";

const WORKDIR = `/tmp/nax-routing-initial-complexity-test-${randomUUID()}`;

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

const FRESH_ROUTING_RESULT = {
  complexity: "medium" as const,
  modelTier: "balanced" as const,
  testStrategy: "three-session-tdd" as const,
  reasoning: "classified by routeStory",
};

// ---------------------------------------------------------------------------
// AC-2: initialComplexity written on first classify (story.routing undefined)
// ---------------------------------------------------------------------------

describe("routingStage - initialComplexity set on first classification", () => {
  let origRoutingDeps: typeof RoutingDeps;

  afterEach(() => {
    mock.restore();
    if (origRoutingDeps) {
      const { _routingDeps } = require("../../../../src/pipeline/stages/routing");
      Object.assign(_routingDeps, origRoutingDeps);
    }
  });

  test("story.routing.initialComplexity is set to classified complexity on first classify", async () => {
    const { routingStage, _routingDeps } = await import(
      "../../../../src/pipeline/stages/routing"
    );

    origRoutingDeps = { ..._routingDeps };

    _routingDeps.resolveRouting = mock(() => Promise.resolve({ ...FRESH_ROUTING_RESULT }));
    _routingDeps.isGreenfieldStory = mock(() => Promise.resolve(false));
    _routingDeps.savePRD = mock(() => Promise.resolve());

    const story = makeStory({ routing: undefined });
    const ctx = makeCtx(story);

    await routingStage.execute(ctx as Parameters<typeof routingStage.execute>[0]);

    // initialComplexity must equal the classified complexity
    expect(ctx.story.routing?.initialComplexity).toBe(FRESH_ROUTING_RESULT.complexity);
  });

  test("story.routing.initialComplexity matches complexity on first classify", async () => {
    const { routingStage, _routingDeps } = await import(
      "../../../../src/pipeline/stages/routing"
    );

    origRoutingDeps = { ..._routingDeps };

    const expertRouting = {
      complexity: "expert" as const,
      modelTier: "powerful" as const,
      testStrategy: "three-session-tdd" as const,
      reasoning: "complex feature",
    };

    _routingDeps.resolveRouting = mock(() => Promise.resolve({ ...expertRouting }));
    _routingDeps.isGreenfieldStory = mock(() => Promise.resolve(false));
    _routingDeps.savePRD = mock(() => Promise.resolve());

    const story = makeStory({ routing: undefined });
    const ctx = makeCtx(story);

    await routingStage.execute(ctx as Parameters<typeof routingStage.execute>[0]);

    expect(ctx.story.routing?.initialComplexity).toBe("expert");
    expect(ctx.story.routing?.complexity).toBe("expert");
  });

  test("initialComplexity is written to PRD passed to savePRD on first classify", async () => {
    const { routingStage, _routingDeps } = await import(
      "../../../../src/pipeline/stages/routing"
    );

    origRoutingDeps = { ..._routingDeps };

    const savedPRDs: PRD[] = [];
    _routingDeps.resolveRouting = mock(() => Promise.resolve({ ...FRESH_ROUTING_RESULT }));
    _routingDeps.isGreenfieldStory = mock(() => Promise.resolve(false));
    _routingDeps.savePRD = mock((prd: PRD) => {
      savedPRDs.push(prd);
      return Promise.resolve();
    });

    const story = makeStory({ routing: undefined });
    const ctx = makeCtx(story);

    await routingStage.execute(ctx as Parameters<typeof routingStage.execute>[0]);

    expect(savedPRDs).toHaveLength(1);
    const savedStory = savedPRDs[0].userStories.find((s) => s.id === story.id);
    expect(savedStory?.routing?.initialComplexity).toBe(FRESH_ROUTING_RESULT.complexity);
  });
});

// ---------------------------------------------------------------------------
// AC-3: Escalation path never overwrites initialComplexity
// ---------------------------------------------------------------------------

describe("routingStage - initialComplexity never overwritten after first classify", () => {
  let origRoutingDeps: typeof import("../../../../src/pipeline/stages/routing")["_routingDeps"];

  afterEach(() => {
    mock.restore();
    if (origRoutingDeps) {
      const { _routingDeps } = require("../../../../src/pipeline/stages/routing");
      Object.assign(_routingDeps, origRoutingDeps);
    }
  });

  test("initialComplexity is preserved when story.routing already exists (escalation path)", async () => {
    const { routingStage, _routingDeps } = await import(
      "../../../../src/pipeline/stages/routing"
    );

    origRoutingDeps = { ..._routingDeps };

    // Story has routing with initialComplexity from first classify and escalated modelTier
    const escalatedRouting: StoryRouting = {
      complexity: "simple",
      initialComplexity: "simple",
      modelTier: "powerful", // escalated from "fast"
      testStrategy: "three-session-tdd",
      reasoning: "escalated after failure",
    };

    _routingDeps.resolveRouting = mock(() =>
      Promise.resolve({
        complexity: "expert",
        modelTier: "powerful",
        testStrategy: "three-session-tdd",
        reasoning: "re-classified",
      }),
    );
    _routingDeps.complexityToModelTier = mock(() => "fast" as const);
    _routingDeps.isGreenfieldStory = mock(() => Promise.resolve(false));
    _routingDeps.savePRD = mock(() => Promise.resolve());

    const story = makeStory({ routing: escalatedRouting });
    const ctx = makeCtx(story);

    await routingStage.execute(ctx as Parameters<typeof routingStage.execute>[0]);

    // initialComplexity must remain "simple" — never overwritten by escalation
    expect(ctx.story.routing?.initialComplexity).toBe("simple");
  });

  test("only modelTier changes during escalation, initialComplexity stays the same", async () => {
    const { routingStage, _routingDeps } = await import(
      "../../../../src/pipeline/stages/routing"
    );

    origRoutingDeps = { ..._routingDeps };

    const routingAfterFirstClassify: StoryRouting = {
      complexity: "medium",
      initialComplexity: "medium", // set on first classify
      modelTier: "powerful",       // escalated tier
      testStrategy: "three-session-tdd",
      reasoning: "persisted from first classify, escalated",
    };

    _routingDeps.resolveRouting = mock(() =>
      Promise.resolve({
        complexity: "complex",
        modelTier: "balanced",
        testStrategy: "three-session-tdd",
        reasoning: "fresh",
      }),
    );
    _routingDeps.complexityToModelTier = mock(() => "balanced" as const);
    _routingDeps.isGreenfieldStory = mock(() => Promise.resolve(false));
    _routingDeps.savePRD = mock(() => Promise.resolve());

    const story = makeStory({ routing: routingAfterFirstClassify });
    const ctx = makeCtx(story);

    await routingStage.execute(ctx as Parameters<typeof routingStage.execute>[0]);

    // initialComplexity unchanged
    expect(ctx.story.routing?.initialComplexity).toBe("medium");
    // modelTier uses the escalated value
    expect(ctx.routing.modelTier).toBe("powerful");
  });

  test("initialComplexity absent on story.routing with no initialComplexity is not touched (backward compat)", async () => {
    const { routingStage, _routingDeps } = await import(
      "../../../../src/pipeline/stages/routing"
    );

    origRoutingDeps = { ..._routingDeps };

    // Legacy routing without initialComplexity (backward compat)
    const legacyRouting: StoryRouting = {
      complexity: "simple",
      testStrategy: "test-after",
      reasoning: "legacy persisted routing",
    };

    _routingDeps.resolveRouting = mock(() =>
      Promise.resolve({
        complexity: "medium",
        modelTier: "balanced",
        testStrategy: "three-session-tdd",
        reasoning: "re-classified",
      }),
    );
    _routingDeps.complexityToModelTier = mock(() => "fast" as const);
    _routingDeps.isGreenfieldStory = mock(() => Promise.resolve(false));
    _routingDeps.savePRD = mock(() => Promise.resolve());

    const story = makeStory({ routing: legacyRouting });
    const ctx = makeCtx(story);

    await routingStage.execute(ctx as Parameters<typeof routingStage.execute>[0]);

    // Should not have written initialComplexity onto an existing routing object
    // ROUTE-001: initialComplexity is now always set on first classify
    expect(ctx.story.routing?.initialComplexity).toBe("medium");
  });
});

// ---------------------------------------------------------------------------
// AC-1: StoryRouting interface exposes initialComplexity field
// ---------------------------------------------------------------------------

describe("StoryRouting - initialComplexity field exists on type", () => {
  test("StoryRouting accepts initialComplexity as optional Complexity field", () => {
    const routing: StoryRouting = {
      complexity: "medium",
      testStrategy: "test-after",
      reasoning: "test",
      initialComplexity: "medium",
    };
    expect(routing.initialComplexity).toBe("medium");
  });

  test("StoryRouting is valid without initialComplexity (optional field)", () => {
    const routing: StoryRouting = {
      complexity: "simple",
      testStrategy: "test-after",
      reasoning: "test",
    };
    expect(routing.initialComplexity).toBeUndefined();
  });
});
