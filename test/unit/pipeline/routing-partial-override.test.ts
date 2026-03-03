/**
 * Tests for partial routing override in routing stage (FIX-001)
 *
 * Verifies that story.routing fields only override LLM-classified results
 * when they are actually set. Prevents undefined values from clobbering
 * a fresh classification.
 */

import { beforeEach, afterEach, describe, expect, mock, test } from "bun:test";
import { initLogger, resetLogger } from "../../../src/logger";
import type { PipelineContext } from "../../../src/pipeline/types";
import type { NaxConfig } from "../../../src/config";
import type { UserStory } from "../../../src/prd/types";

// ── Module mocks (must be declared before dynamic imports) ────────────────────

const mockRouteStory = mock(async () => ({
  complexity: "medium",
  modelTier: "balanced",
  testStrategy: "three-session-tdd",
  reasoning: "LLM classified as medium",
}));

const mockComplexityToModelTier = mock((_complexity: string, _config: unknown) => "balanced" as const);

mock.module("../../../src/routing", () => ({
  routeStory: mockRouteStory,
  complexityToModelTier: mockComplexityToModelTier,
}));

// Greenfield check: return false so it never interferes with test strategy
mock.module("../../../src/context/greenfield", () => ({
  isGreenfieldStory: mock(async () => false),
}));

// LLM batch cache is not relevant here
mock.module("../../../src/routing/strategies/llm", () => ({
  clearCache: mock(() => {}),
  routeBatch: mock(async () => []),
}));

// ── Dynamic imports after mocks ───────────────────────────────────────────────

const { routingStage } = await import("../../../src/pipeline/stages/routing");

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
    } as unknown as NaxConfig,
    story,
    stories: [story],
    routing: {} as PipelineContext["routing"],
    workdir: "/tmp/nax-test-partial-routing",
    prd: { feature: "test", userStories: [story] } as PipelineContext["prd"],
    hooks: {} as PipelineContext["hooks"],
  } as PipelineContext;
}

// ── Logger setup ──────────────────────────────────────────────────────────────

beforeEach(() => {
  resetLogger();
  initLogger({ level: "error", useChalk: false });
  mockRouteStory.mockClear();
  mockComplexityToModelTier.mockClear();
});

afterEach(() => {
  resetLogger();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("routing stage — partial override (FIX-001)", () => {
  test("(1) partial override with only testStrategy preserves LLM complexity", async () => {
    // Story sets only testStrategy — complexity should come from LLM
    const story = makeStory({ testStrategy: "test-after", complexity: undefined as any, reasoning: "manual" });
    const ctx = makeCtx(story);

    await routingStage.execute(ctx);

    // testStrategy is overridden by the story field
    expect(ctx.routing.testStrategy).toBe("test-after");
    // complexity should remain from the LLM result ("medium"), not undefined
    expect(ctx.routing.complexity).toBe("medium");
  });

  test("(2) LLM-classified complexity is preserved when story.routing has no complexity", async () => {
    // story.routing is present but complexity is undefined (falsy)
    const story = makeStory({ testStrategy: "test-after", complexity: undefined as any, reasoning: "" });
    const ctx = makeCtx(story);

    await routingStage.execute(ctx);

    // LLM returned "medium" — it must not be overwritten with undefined
    expect(ctx.routing.complexity).toBe("medium");
    expect(ctx.routing.complexity).not.toBeUndefined();
  });

  test("(3) full override works when both complexity and testStrategy are set", async () => {
    // Story has explicit values for both fields
    const story = makeStory({
      complexity: "simple",
      testStrategy: "test-after",
      reasoning: "manual override",
    });
    const ctx = makeCtx(story);

    await routingStage.execute(ctx);

    // Both fields should be overridden from the story
    expect(ctx.routing.complexity).toBe("simple");
    expect(ctx.routing.testStrategy).toBe("test-after");
  });
});
