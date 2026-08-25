// RE-ARCH: keep
/**
 * Tests for routing stage behavior (BUG-032 + FIX-001)
 *
 * BUG-032: Escalated modelTier in story.routing is preserved after re-routing.
 * FIX-001: initialComplexity is set on first routing and not overwritten.
 * The new routing stage always applies the full resolveRouting() decision —
 * no partial testStrategy/complexity override from story.routing.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { makeNaxConfig } from "@test/helpers";
import { DEFAULT_CONFIG } from "@/config";
import { initLogger, resetLogger } from "@/logger";
import { _routingDeps, routingStage } from "@/pipeline/stages/routing";
import type { PipelineContext } from "@/pipeline/types";
import type { UserStory } from "@/prd/types";

const WORKDIR = `/tmp/nax-test-partial-routing-${randomUUID()}`;

// ── Mock functions ────────────────────────────────────────────────────────────

const mockResolveRouting = mock(async () => ({
  complexity: "medium",
  modelTier: "balanced",
  testStrategy: "three-session-tdd",
  reasoning: "LLM classified as medium",
}));

const mockIsGreenfieldStory = mock(async () => false);
const mockSavePRD = mock(async () => {});

// ── Capture originals for afterEach restoration ───────────────────────────────

const _origDeps = { ..._routingDeps };

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeStory(routingOverride?: Partial<UserStory["routing"]>): UserStory {
  const story: UserStory = {
    id: "FIX-001-test",
    title: "Partial routing override test",
    description: "Tests that story.routing only overrides when set",
    acceptanceCriteria: [],
    status: "pending",
    passes: false,
    escalations: [],
    attempts: 0,
    tags: [],
    dependencies: [],
  };
  if (routingOverride !== undefined) {
    story.routing = routingOverride as UserStory["routing"];
  }
  return story;
}

function makeCtx(story: UserStory): PipelineContext {
  return {
    config: makeNaxConfig({
      tdd: { greenfieldDetection: false },
      autoMode: { complexityRouting: {} },
      routing: { strategy: "llm", llm: { mode: "per-story" } },
      execution: { agent: "claude" },
    }),
    rootConfig: DEFAULT_CONFIG,
    story,
    stories: [story],
    routing: {} as PipelineContext["routing"],
    workdir: WORKDIR,
    projectDir: WORKDIR,
    prd: { feature: "test", userStories: [story] } as PipelineContext["prd"],
    hooks: {} as PipelineContext["hooks"],
  } as PipelineContext;
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  resetLogger();
  initLogger({ level: "silent" });
  _routingDeps.resolveRouting = mockResolveRouting as typeof _routingDeps.resolveRouting;
  _routingDeps.isGreenfieldStory = mockIsGreenfieldStory as typeof _routingDeps.isGreenfieldStory;
  _routingDeps.savePRD = mockSavePRD as typeof _routingDeps.savePRD;
  mockResolveRouting.mockClear();
  mockIsGreenfieldStory.mockClear();
});

afterEach(() => {
  Object.assign(_routingDeps, _origDeps);
  mock.restore();
  resetLogger();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("routing stage — resolveRouting integration (BUG-032 + FIX-001)", () => {
  test("(1) routing decision from resolveRouting is applied to ctx.routing", async () => {
    const story = makeStory();
    const ctx = makeCtx(story);

    await routingStage.execute(ctx);

    expect(ctx.routing.complexity).toBe("medium");
    expect(ctx.routing.testStrategy).toBe("three-session-tdd");
    expect(ctx.routing.modelTier).toBe("balanced");
  });

  test("(2) escalated modelTier from story.routing is preserved (BUG-032)", async () => {
    // Simulate escalation: story.routing.modelTier was bumped to "powerful"
    const story = makeStory({
      modelTier: "powerful",
      complexity: "medium",
      testStrategy: "three-session-tdd",
      reasoning: "escalated",
    });
    const ctx = makeCtx(story);

    await routingStage.execute(ctx);

    // BUG-032: escalated tier must survive re-routing
    expect(ctx.routing.modelTier).toBe("powerful");
    // complexity from decision is applied
    expect(ctx.routing.complexity).toBe("medium");
  });

  test("(4) sideways/downward cross-agent tier escalation is preserved even when it does not outrank the candidate (#1522)", async () => {
    // A cross-agent rung ladder can escalate sideways or down (e.g.
    // agentA/powerful -> agentB/balanced). handleTierEscalation wrote
    // modelTier="balanced" and appended an escalation record. If the router
    // re-derives "powerful" again (TIER_RANK.powerful > TIER_RANK.balanced),
    // rank-only comparison would discard the escalation and snap back to
    // "powerful" — silently reverting the escalated agent's rung and
    // resetting the story-scoped fix budget key (storyFixKey).
    mockResolveRouting.mockImplementationOnce(async () => ({
      complexity: "expert",
      modelTier: "powerful",
      testStrategy: "three-session-tdd",
      reasoning: "re-classified as expert",
    }));

    const story = makeStory({
      modelTier: "balanced", // escalated-to tier, does not outrank "powerful"
      complexity: "medium",
      testStrategy: "three-session-tdd",
      reasoning: "escalated cross-agent",
    });
    story.escalations = [
      { fromTier: "powerful", toTier: "balanced", reason: "cross-agent rung", timestamp: new Date().toISOString() },
    ];
    const ctx = makeCtx(story);

    await routingStage.execute(ctx);

    // The escalated tier must survive re-routing — an escalation record is
    // authoritative regardless of rank comparison.
    expect(ctx.routing.modelTier).toBe("balanced");
  });

  test("(3) initialComplexity is set from first routing and not overwritten on retry", async () => {
    const story = makeStory();
    const ctx = makeCtx(story);

    // First routing — no initialComplexity
    await routingStage.execute(ctx);
    expect(ctx.story.routing?.initialComplexity).toBe("medium");

    // Second routing — initialComplexity should stay "medium"
    await routingStage.execute(ctx);
    expect(ctx.story.routing?.initialComplexity).toBe("medium");
  });
});
