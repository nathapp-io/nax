/**
 * Routing Stage — H1: profileModelTier seeds the starting rung (Open Item B)
 *                 H2: initialAgent / initialProfileId written once on first route
 *
 * Interpretation A (DECIDED 2026-06-11): a selected profile's target tier
 * overrides the complexity-derived tier unconditionally. A cheap profile can
 * start a complex story at "fast" — escalation recovers upward if needed.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { DEFAULT_CONFIG } from "@/config";
import type { PRD, UserStory } from "@/prd";
import type { _routingDeps as RoutingDeps } from "@/pipeline/stages/routing";
import type { PipelineContext } from "@/pipeline/types";
import type { StoryRouting } from "@/prd/types";
import { makeNaxConfig, makeStory } from "@test/helpers";

const WORKDIR = `/tmp/nax-routing-profile-tier-test-${randomUUID()}`;

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

// ---------------------------------------------------------------------------
// H1 — profileModelTier seeds the starting tier
// ---------------------------------------------------------------------------

describe("routingStage — H1: profileModelTier seeds starting tier", () => {
  let origRoutingDeps: typeof RoutingDeps;

  afterEach(() => {
    if (origRoutingDeps) {
      const { _routingDeps } = require("../../../../src/pipeline/stages/routing");
      Object.assign(_routingDeps, origRoutingDeps);
    }
  });

  test("upward override — profileModelTier=powerful beats complexity-derived fast", async () => {
    const { routingStage, _routingDeps } = await import(
      "../../../../src/pipeline/stages/routing"
    );
    origRoutingDeps = { ..._routingDeps };

    _routingDeps.resolveRouting = () =>
      Promise.resolve({ complexity: "simple" as const, modelTier: "fast" as const, testStrategy: "test-after" as const, reasoning: "keyword" });
    _routingDeps.isGreenfieldStory = () => Promise.resolve(false);
    _routingDeps.savePRD = () => Promise.resolve();

    const story = makeStory({
      routing: { complexity: "simple", testStrategy: "test-after", reasoning: "", profileModelTier: "powerful" as const },
    });
    const ctx = makeCtx(story);

    await routingStage.execute(ctx as Parameters<typeof routingStage.execute>[0]);

    expect(ctx.story.routing?.modelTier).toBe("powerful");
  });

  test("downward override (Interpretation A) — a cheap profile starts a complex story at fast — escalation recovers", async () => {
    const { routingStage, _routingDeps } = await import(
      "../../../../src/pipeline/stages/routing"
    );
    origRoutingDeps = { ..._routingDeps };

    _routingDeps.resolveRouting = () =>
      Promise.resolve({ complexity: "expert" as const, modelTier: "powerful" as const, testStrategy: "three-session-tdd" as const, reasoning: "llm" });
    _routingDeps.isGreenfieldStory = () => Promise.resolve(false);
    _routingDeps.savePRD = () => Promise.resolve();

    const story = makeStory({
      routing: { complexity: "expert", testStrategy: "three-session-tdd", reasoning: "", profileModelTier: "fast" as const },
    });
    const ctx = makeCtx(story);

    await routingStage.execute(ctx as Parameters<typeof routingStage.execute>[0]);

    // Profile "fast" fully overrides complexity-derived "powerful" (Interpretation A)
    expect(ctx.story.routing?.modelTier).toBe("fast");
  });

  test("escalation still wins — escalated powerful is preserved over profileModelTier fast", async () => {
    const { routingStage, _routingDeps } = await import(
      "../../../../src/pipeline/stages/routing"
    );
    origRoutingDeps = { ..._routingDeps };

    _routingDeps.resolveRouting = () =>
      Promise.resolve({ complexity: "simple" as const, modelTier: "fast" as const, testStrategy: "test-after" as const, reasoning: "keyword" });
    _routingDeps.isGreenfieldStory = () => Promise.resolve(false);
    _routingDeps.savePRD = () => Promise.resolve();

    // Story already escalated to powerful; profile says fast
    const routing: StoryRouting = {
      complexity: "simple",
      modelTier: "powerful",    // escalated tier already stored
      testStrategy: "test-after",
      reasoning: "",
      profileModelTier: "fast", // profile baseline
    };
    const story = makeStory({ routing });
    const ctx = makeCtx(story);

    await routingStage.execute(ctx as Parameters<typeof routingStage.execute>[0]);

    // Escalation wins — powerful > fast
    expect(ctx.story.routing?.modelTier).toBe("powerful");
  });

  test("story with no profileModelTier uses complexity-derived tier (regression guard)", async () => {
    const { routingStage, _routingDeps } = await import(
      "../../../../src/pipeline/stages/routing"
    );
    origRoutingDeps = { ..._routingDeps };

    _routingDeps.resolveRouting = () =>
      Promise.resolve({ complexity: "medium" as const, modelTier: "balanced" as const, testStrategy: "three-session-tdd" as const, reasoning: "keyword" });
    _routingDeps.isGreenfieldStory = () => Promise.resolve(false);
    _routingDeps.savePRD = () => Promise.resolve();

    const story = makeStory({ routing: undefined });
    const ctx = makeCtx(story);

    await routingStage.execute(ctx as Parameters<typeof routingStage.execute>[0]);

    expect(ctx.story.routing?.modelTier).toBe("balanced");
  });

  test("unknown/custom profileModelTier passes through as start tier without crash", async () => {
    const { routingStage, _routingDeps } = await import(
      "../../../../src/pipeline/stages/routing"
    );
    origRoutingDeps = { ..._routingDeps };

    _routingDeps.resolveRouting = () =>
      Promise.resolve({ complexity: "simple" as const, modelTier: "fast" as const, testStrategy: "test-after" as const, reasoning: "keyword" });
    _routingDeps.isGreenfieldStory = () => Promise.resolve(false);
    _routingDeps.savePRD = () => Promise.resolve();

    const story = makeStory({
      routing: { complexity: "simple", testStrategy: "test-after", reasoning: "", profileModelTier: "custom-tier" as any },
    });
    const ctx = makeCtx(story);

    // Must not throw even when TIER_RANK has no entry for "custom-tier"
    await routingStage.execute(ctx as Parameters<typeof routingStage.execute>[0]);

    // Custom tier becomes the starting tier (candidateRank === undefined → isEscalated === false)
    expect(ctx.story.routing?.modelTier).toBe("custom-tier");
  });

  test("mapper-produced story with profileModelTier=fast routes to fast, not the mapper default", async () => {
    const { routingStage, _routingDeps } = await import(
      "../../../../src/pipeline/stages/routing"
    );
    const { mapDecomposedStoriesToUserStories } = await import(
      "../../../../src/prd/decompose-mapper"
    );
    origRoutingDeps = { ..._routingDeps };

    _routingDeps.resolveRouting = () =>
      Promise.resolve({ complexity: "medium" as const, modelTier: "balanced" as const, testStrategy: "test-after" as const, reasoning: "x" });
    _routingDeps.isGreenfieldStory = () => Promise.resolve(false);
    _routingDeps.savePRD = () => Promise.resolve();

    const [story] = mapDecomposedStoriesToUserStories(
      [
        {
          id: "US-001-A",
          title: "t",
          description: "d",
          acceptanceCriteria: ["a"],
          tags: [],
          dependencies: [],
          contextFiles: ["f.ts"],
          complexity: "medium" as const,
          testStrategy: "test-after" as const,
          reasoning: "r",
          routing: { agent: "opencode", agentProfileId: "oc-fast", profileModelTier: "fast" as const },
        },
      ],
      "US-001",
    );
    const ctx = makeCtx(makeStory({ ...story }));

    await routingStage.execute(ctx as Parameters<typeof routingStage.execute>[0]);

    expect(ctx.story.routing?.modelTier).toBe("fast");
  });

  test("idempotence — running routingStage twice on a profile-seeded story yields stable modelTier", async () => {
    const { routingStage, _routingDeps } = await import(
      "../../../../src/pipeline/stages/routing"
    );
    origRoutingDeps = { ..._routingDeps };

    _routingDeps.resolveRouting = () =>
      Promise.resolve({ complexity: "simple" as const, modelTier: "fast" as const, testStrategy: "test-after" as const, reasoning: "keyword" });
    _routingDeps.isGreenfieldStory = () => Promise.resolve(false);
    _routingDeps.savePRD = () => Promise.resolve();

    const story = makeStory({
      routing: { complexity: "simple", testStrategy: "test-after", reasoning: "", profileModelTier: "balanced" as const },
    });
    const ctx = makeCtx(story);

    await routingStage.execute(ctx as Parameters<typeof routingStage.execute>[0]);
    const tierAfterFirst = ctx.story.routing?.modelTier;

    await routingStage.execute(ctx as Parameters<typeof routingStage.execute>[0]);
    const tierAfterSecond = ctx.story.routing?.modelTier;

    expect(tierAfterFirst).toBe("balanced");
    expect(tierAfterSecond).toBe("balanced");
  });
});

// ---------------------------------------------------------------------------
// H2 — initialAgent / initialProfileId written once on first route
// ---------------------------------------------------------------------------

describe("routingStage — H2: initialAgent / initialProfileId written once", () => {
  let origRoutingDeps: typeof RoutingDeps;

  afterEach(() => {
    if (origRoutingDeps) {
      const { _routingDeps } = require("../../../../src/pipeline/stages/routing");
      Object.assign(_routingDeps, origRoutingDeps);
    }
  });

  test("initialAgent and initialProfileId captured from first route", async () => {
    const { routingStage, _routingDeps } = await import(
      "../../../../src/pipeline/stages/routing"
    );
    origRoutingDeps = { ..._routingDeps };

    _routingDeps.resolveRouting = () =>
      Promise.resolve({ complexity: "simple" as const, modelTier: "fast" as const, testStrategy: "test-after" as const, reasoning: "keyword" });
    _routingDeps.isGreenfieldStory = () => Promise.resolve(false);
    _routingDeps.savePRD = () => Promise.resolve();

    const story = makeStory({
      routing: {
        complexity: "simple",
        testStrategy: "test-after",
        reasoning: "",
        agent: "opencode",
        agentProfileId: "oc-bal",
      },
    });
    const ctx = makeCtx(story);

    await routingStage.execute(ctx as Parameters<typeof routingStage.execute>[0]);

    expect(ctx.story.routing?.initialAgent).toBe("opencode");
    expect(ctx.story.routing?.initialProfileId).toBe("oc-bal");
  });

  test("initialAgent is not overwritten after escalation changes routing.agent", async () => {
    const { routingStage, _routingDeps } = await import(
      "../../../../src/pipeline/stages/routing"
    );
    origRoutingDeps = { ..._routingDeps };

    _routingDeps.resolveRouting = () =>
      Promise.resolve({ complexity: "simple" as const, modelTier: "fast" as const, testStrategy: "test-after" as const, reasoning: "keyword" });
    _routingDeps.isGreenfieldStory = () => Promise.resolve(false);
    _routingDeps.savePRD = () => Promise.resolve();

    // First route: agent = opencode, initialAgent set
    const story = makeStory({
      routing: {
        complexity: "simple",
        testStrategy: "test-after",
        reasoning: "",
        agent: "opencode",
        agentProfileId: "oc-bal",
        initialAgent: "opencode",   // already written on first route
        initialProfileId: "oc-bal",
      },
    });

    // Simulate escalation changing the agent
    story.routing!.agent = "claude";

    const ctx = makeCtx(story);

    await routingStage.execute(ctx as Parameters<typeof routingStage.execute>[0]);

    // initialAgent must remain the original value, not the escalated agent
    expect(ctx.story.routing?.initialAgent).toBe("opencode");
  });

  test("story with no agent assignment produces no initialAgent or initialProfileId keys", async () => {
    const { routingStage, _routingDeps } = await import(
      "../../../../src/pipeline/stages/routing"
    );
    origRoutingDeps = { ..._routingDeps };

    _routingDeps.resolveRouting = () =>
      Promise.resolve({ complexity: "simple" as const, modelTier: "fast" as const, testStrategy: "test-after" as const, reasoning: "keyword" });
    _routingDeps.isGreenfieldStory = () => Promise.resolve(false);
    _routingDeps.savePRD = () => Promise.resolve();

    const story = makeStory({ routing: undefined });
    const ctx = makeCtx(story);

    await routingStage.execute(ctx as Parameters<typeof routingStage.execute>[0]);

    // Neither field should be written as undefined keys
    expect("initialAgent" in (ctx.story.routing ?? {})).toBe(false);
    expect("initialProfileId" in (ctx.story.routing ?? {})).toBe(false);
  });
});
