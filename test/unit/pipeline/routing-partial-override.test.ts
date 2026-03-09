// RE-ARCH: keep
/**
 * Tests for partial routing override in routing stage (FIX-001)
 *
 * Verifies that story.routing fields only override LLM-classified results
 * when they are actually set. Prevents undefined values from clobbering
 * a fresh classification.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { initLogger, resetLogger } from "../../../src/logger";
import { _routingDeps, routingStage } from "../../../src/pipeline/stages/routing";
import type { NaxConfig } from "../../../src/config";
import type { PipelineContext } from "../../../src/pipeline/types";
import type { UserStory } from "../../../src/prd/types";

// ── Mock functions ────────────────────────────────────────────────────────────

const mockRouteStory = mock(async () => ({
  complexity: "medium",
  modelTier: "balanced",
  testStrategy: "three-session-tdd",
  reasoning: "LLM classified as medium",
}));

const mockComplexityToModelTier = mock((_complexity: string, _config: unknown) => "balanced" as const);
const mockIsGreenfieldStory = mock(async () => false);

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
    config: {
      tdd: { greenfieldDetection: false },
      autoMode: { complexityRouting: {} },
      routing: { strategy: "complexity", llm: { mode: "per-story" } },
      execution: { agent: "claude" },
    } as unknown as NaxConfig,
    story,
    stories: [story],
    routing: {} as PipelineContext["routing"],
    workdir: "/tmp/nax-test-partial-routing",
    prd: { feature: "test", userStories: [story] } as PipelineContext["prd"],
    hooks: {} as PipelineContext["hooks"],
  } as PipelineContext;
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  resetLogger();
  initLogger({ level: "error", useChalk: false });
  _routingDeps.routeStory = mockRouteStory as typeof _routingDeps.routeStory;
  _routingDeps.complexityToModelTier = mockComplexityToModelTier as typeof _routingDeps.complexityToModelTier;
  _routingDeps.isGreenfieldStory = mockIsGreenfieldStory as typeof _routingDeps.isGreenfieldStory;
  mockRouteStory.mockClear();
  mockComplexityToModelTier.mockClear();
  mockIsGreenfieldStory.mockClear();
});

afterEach(() => {
  Object.assign(_routingDeps, _origDeps);
  mock.restore();
  resetLogger();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("routing stage — partial override (FIX-001)", () => {
  test("(1) partial override with only testStrategy preserves LLM complexity", async () => {
    const story = makeStory({ testStrategy: "test-after", complexity: undefined as any, reasoning: "manual" });
    const ctx = makeCtx(story);

    await routingStage.execute(ctx);

    expect(ctx.routing.testStrategy).toBe("test-after");
    expect(ctx.routing.complexity).toBe("medium");
  });

  test("(2) LLM-classified complexity is preserved when story.routing has no complexity", async () => {
    const story = makeStory({ testStrategy: "test-after", complexity: undefined as any, reasoning: "" });
    const ctx = makeCtx(story);

    await routingStage.execute(ctx);

    expect(ctx.routing.complexity).toBe("medium");
    expect(ctx.routing.complexity).not.toBeUndefined();
  });

  test("(3) full override works when both complexity and testStrategy are set", async () => {
    const story = makeStory({ complexity: "simple", testStrategy: "test-after", reasoning: "manual override" });
    const ctx = makeCtx(story);

    await routingStage.execute(ctx);

    expect(ctx.routing.complexity).toBe("simple");
    expect(ctx.routing.testStrategy).toBe("test-after");
  });
});
