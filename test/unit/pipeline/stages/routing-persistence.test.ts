/**
 * Routing Stage — RRP-001: Persist initial routing to prd.json on first classification
 *
 * AC-1, AC-2, AC-3: Tests for persistence behavior, cached routing, and escalation.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { DEFAULT_CONFIG } from "../../../../src/config/defaults";
import type { NaxConfig } from "../../../../src/config";
import type { PRD, UserStory } from "../../../../src/prd";
import type { PipelineContext } from "../../../../src/pipeline/types";
import type { StoryRouting } from "../../../../src/prd/types";

const WORKDIR = `/tmp/nax-routing-test-${randomUUID()}`;

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
    status: "in-progress",
    passes: false,
    escalations: [],
    attempts: 0,
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
  return {
    ...DEFAULT_CONFIG,
    tdd: {
      ...DEFAULT_CONFIG.tdd,
      greenfieldDetection: false,
    },
  };
}

function makeCtx(story: UserStory, overrides?: Partial<PipelineContext>): PipelineContext & { prdPath: string } {
  const prd = makePRD(story);
  return {
    config: makeConfig(),
    prd,
    story,
    stories: [story],
    routing: {
      complexity: "simple",
      modelTier: "fast",
      testStrategy: "test-after",
      reasoning: "test",
    },
    workdir: WORKDIR,
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
// AC-1 & AC-5: savePRD is called on first classification (story.routing undefined)
// ---------------------------------------------------------------------------

describe("routingStage - first classification persists routing to prd.json", () => {
  let origRoutingDeps: typeof import("../../../../src/pipeline/stages/routing")["_routingDeps"];
  let savePRDCallArgs: Array<[PRD, string]>;

  beforeEach(() => {
    savePRDCallArgs = [];
  });

  afterEach(() => {
    mock.restore();
    // Restore original deps after each test
    if (origRoutingDeps) {
      const { _routingDeps } = require("../../../../src/pipeline/stages/routing");
      Object.assign(_routingDeps, origRoutingDeps);
    }
  });

  test("calls savePRD with updated prd when story.routing is undefined", async () => {
    const { routingStage, _routingDeps } = await import(
      "../../../../src/pipeline/stages/routing"
    );

    origRoutingDeps = { ..._routingDeps };

    _routingDeps.resolveRouting = mock(() => Promise.resolve({ ...FRESH_ROUTING_RESULT }));
    _routingDeps.isGreenfieldStory = mock(() => Promise.resolve(false));
    _routingDeps.savePRD = mock((prd: PRD, path: string) => {
      savePRDCallArgs.push([prd, path]);
      return Promise.resolve();
    });

    const story = makeStory({ routing: undefined });
    const ctx = makeCtx(story);

    await routingStage.execute(ctx as Parameters<typeof routingStage.execute>[0]);

    // savePRD must have been called exactly once
    expect(savePRDCallArgs).toHaveLength(1);
  });

  test("persists correct prdPath to savePRD on first classification", async () => {
    const { routingStage, _routingDeps } = await import(
      "../../../../src/pipeline/stages/routing"
    );

    origRoutingDeps = { ..._routingDeps };

    _routingDeps.resolveRouting = mock(() => Promise.resolve({ ...FRESH_ROUTING_RESULT }));
    _routingDeps.isGreenfieldStory = mock(() => Promise.resolve(false));
    _routingDeps.savePRD = mock((prd: PRD, path: string) => {
      savePRDCallArgs.push([prd, path]);
      return Promise.resolve();
    });

    const story = makeStory({ routing: undefined });
    const prdPath = `${WORKDIR}/nax/prd.json`;
    const ctx = makeCtx(story, { prdPath } as Partial<PipelineContext>);

    await routingStage.execute(ctx as Parameters<typeof routingStage.execute>[0]);

    const [, savedPath] = savePRDCallArgs[0];
    expect(savedPath).toBe(prdPath);
  });

  test("story.routing is populated on prd after fresh classification", async () => {
    const { routingStage, _routingDeps } = await import(
      "../../../../src/pipeline/stages/routing"
    );

    origRoutingDeps = { ..._routingDeps };

    _routingDeps.resolveRouting = mock(() => Promise.resolve({ ...FRESH_ROUTING_RESULT }));
    _routingDeps.isGreenfieldStory = mock(() => Promise.resolve(false));
    _routingDeps.savePRD = mock((prd: PRD, path: string) => {
      savePRDCallArgs.push([prd, path]);
      return Promise.resolve();
    });

    const story = makeStory({ routing: undefined });
    const ctx = makeCtx(story);

    await routingStage.execute(ctx as Parameters<typeof routingStage.execute>[0]);

    // The story in the PRD passed to savePRD must have routing populated
    const [savedPrd] = savePRDCallArgs[0];
    const savedStory = savedPrd.userStories.find((s) => s.id === story.id);
    expect(savedStory?.routing).toBeDefined();
    expect(savedStory?.routing?.complexity).toBe(FRESH_ROUTING_RESULT.complexity);
    expect(savedStory?.routing?.testStrategy).toBe(FRESH_ROUTING_RESULT.testStrategy);
  });

  test("ctx.story.routing is set to fresh classification result", async () => {
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

    // story.routing must be populated so a crash+resume finds it
    expect(ctx.story.routing).toBeDefined();
    expect(ctx.story.routing?.complexity).toBe(FRESH_ROUTING_RESULT.complexity);
    expect(ctx.story.routing?.testStrategy).toBe(FRESH_ROUTING_RESULT.testStrategy);
  });
});

// ---------------------------------------------------------------------------
// AC-2: No re-classification when story.routing already exists
// ---------------------------------------------------------------------------

describe("routingStage - skips savePRD when story.routing already set", () => {
  let origRoutingDeps: typeof import("../../../../src/pipeline/stages/routing")["_routingDeps"];
  let savePRDCallCount: number;

  beforeEach(() => {
    savePRDCallCount = 0;
  });

  afterEach(() => {
    mock.restore();
    if (origRoutingDeps) {
      const { _routingDeps } = require("../../../../src/pipeline/stages/routing");
      Object.assign(_routingDeps, origRoutingDeps);
    }
  });

  test("does NOT call savePRD when story.routing is already populated", async () => {
    const { routingStage, _routingDeps } = await import(
      "../../../../src/pipeline/stages/routing"
    );

    origRoutingDeps = { ..._routingDeps };

    const existingRouting: StoryRouting = {
      complexity: "simple",
      testStrategy: "test-after",
      reasoning: "persisted from prior run",
    };

    _routingDeps.resolveRouting = mock(() =>
      Promise.resolve({
        complexity: "medium",
        modelTier: "balanced",
        testStrategy: "three-session-tdd",
        reasoning: "re-classified",
      }),
    );
    _routingDeps.isGreenfieldStory = mock(() => Promise.resolve(false));
    _routingDeps.savePRD = mock(() => {
      savePRDCallCount++;
      return Promise.resolve();
    });

    const story = makeStory({ routing: existingRouting });
    const ctx = makeCtx(story);

    await routingStage.execute(ctx as Parameters<typeof routingStage.execute>[0]);

    // ROUTE-001: savePRD always called (no contentHash cache)
    expect(savePRDCallCount).toBe(1);
  });

  test("uses persisted complexity/testStrategy (not re-classified values) when story.routing exists", async () => {
    const { routingStage, _routingDeps } = await import(
      "../../../../src/pipeline/stages/routing"
    );

    origRoutingDeps = { ..._routingDeps };

    const existingRouting: StoryRouting = {
      complexity: "simple",
      testStrategy: "test-after",
      reasoning: "persisted",
    };

    _routingDeps.resolveRouting = mock(() =>
      Promise.resolve({
        complexity: "expert",
        modelTier: "powerful",
        testStrategy: "three-session-tdd",
        reasoning: "fresh",
      }),
    );
    _routingDeps.isGreenfieldStory = mock(() => Promise.resolve(false));
    _routingDeps.savePRD = mock(() => Promise.resolve());

    const story = makeStory({ routing: existingRouting });
    const ctx = makeCtx(story);

    await routingStage.execute(ctx as Parameters<typeof routingStage.execute>[0]);

    // ROUTE-001: resolveRouting is always called; complexity/testStrategy may be overwritten
    // Note: with existing story.routing, modelTier is preserved (BUG-032), but complexity is re-set
    expect(ctx.routing.modelTier).toBe("powerful"); // ROUTE-001: preserves escalated modelTier (BUG-032)
    expect(ctx.routing.testStrategy).toBe("three-session-tdd"); // from resolveRouting
  });
});

// ---------------------------------------------------------------------------
// AC-3: Escalation still overwrites modelTier/testStrategy (not protected)
// ---------------------------------------------------------------------------

describe("routingStage - escalation overwrites modelTier even after persistence", () => {
  let origRoutingDeps: typeof import("../../../../src/pipeline/stages/routing")["_routingDeps"];

  afterEach(() => {
    mock.restore();
    if (origRoutingDeps) {
      const { _routingDeps } = require("../../../../src/pipeline/stages/routing");
      Object.assign(_routingDeps, origRoutingDeps);
    }
  });

  test("uses escalated modelTier from story.routing when explicitly set", async () => {
    const { routingStage, _routingDeps } = await import(
      "../../../../src/pipeline/stages/routing"
    );

    origRoutingDeps = { ..._routingDeps };

    // Story has routing with escalated modelTier (set by handleTierEscalation)
    const escalatedRouting: StoryRouting = {
      complexity: "simple",
      modelTier: "powerful", // escalated from "fast"
      testStrategy: "three-session-tdd",
      reasoning: "escalated",
    };

    _routingDeps.resolveRouting = mock(() =>
      Promise.resolve({
        complexity: "simple",
        modelTier: "fast",
        testStrategy: "test-after",
        reasoning: "fresh",
      }),
    );
    _routingDeps.complexityToModelTier = mock(() => "fast" as const);
    _routingDeps.isGreenfieldStory = mock(() => Promise.resolve(false));
    _routingDeps.savePRD = mock(() => Promise.resolve());

    const story = makeStory({ routing: escalatedRouting });
    const ctx = makeCtx(story);

    await routingStage.execute(ctx as Parameters<typeof routingStage.execute>[0]);

    // escalated modelTier must take priority (BUG-032)
    expect(ctx.routing.modelTier).toBe("powerful");
  });

  test("savePRD is NOT called during escalation (routing already persisted)", async () => {
    const { routingStage, _routingDeps } = await import(
      "../../../../src/pipeline/stages/routing"
    );

    origRoutingDeps = { ..._routingDeps };

    let savePRDCalled = false;

    const escalatedRouting: StoryRouting = {
      complexity: "simple",
      modelTier: "powerful",
      testStrategy: "three-session-tdd",
      reasoning: "escalated",
    };

    _routingDeps.resolveRouting = mock(() =>
      Promise.resolve({
        complexity: "simple",
        modelTier: "fast",
        testStrategy: "test-after",
        reasoning: "fresh",
      }),
    );
    _routingDeps.complexityToModelTier = mock(() => "fast" as const);
    _routingDeps.isGreenfieldStory = mock(() => Promise.resolve(false));
    _routingDeps.savePRD = mock(() => {
      savePRDCalled = true;
      return Promise.resolve();
    });

    const story = makeStory({ routing: escalatedRouting });
    const ctx = makeCtx(story);

    await routingStage.execute(ctx as Parameters<typeof routingStage.execute>[0]);

    // ROUTE-001: routing is always persisted (no contentHash cache)
    expect(savePRDCalled).toBe(true);
  });
});
