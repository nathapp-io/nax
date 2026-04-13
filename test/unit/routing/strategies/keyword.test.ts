/**
 * TS-001: keyword routing — tdd-simple test strategy type and routing
 *
 * Uses classifyComplexity + determineTestStrategy directly (the deleted
 * keywordStrategy object was a thin wrapper around these same functions).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { NaxConfig } from "../../../../src/config";
import { DEFAULT_CONFIG } from "../../../../src/config/defaults";
import { initLogger, resetLogger } from "../../../../src/logger";
import type { UserStory } from "../../../../src/prd/types";
import { classifyComplexity, complexityToModelTier, determineTestStrategy } from "../../../../src/routing";
import type { RoutingDecision } from "../../../../src/routing";

// ---------------------------------------------------------------------------
// Helper: replaces the deleted keywordStrategy.route(story, ctx)
// ---------------------------------------------------------------------------

function keywordRoute(story: UserStory, config: NaxConfig): RoutingDecision {
  const tddStrategy = config.tdd?.strategy ?? "auto";
  const complexity = classifyComplexity(story.title, story.description, story.acceptanceCriteria, story.tags ?? []);
  const modelTier = complexityToModelTier(complexity, config);
  const testStrategy = determineTestStrategy(complexity, story.title, story.description, story.tags ?? [], tddStrategy);
  return { complexity, modelTier, testStrategy, reasoning: `${testStrategy}: ${complexity} task` };
}

const cfg: NaxConfig = { ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing, llm: undefined } };

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeStory(overrides: Partial<UserStory> = {}): UserStory {
  return {
    id: "TEST-001",
    title: "Add submit button",
    description: "Simple UI feature",
    acceptanceCriteria: ["Button renders", "Click triggers action"],
    tags: [],
    dependencies: [],
    status: "pending",
    passes: false,
    escalations: [],
    attempts: 0,
    ...overrides,
  };
}

beforeEach(() => {
  resetLogger();
  initLogger({ level: "error", useChalk: false });
});

afterEach(() => {
  mock.restore();
  resetLogger();
});

// ---------------------------------------------------------------------------
// TS-001: simple complexity → tdd-simple
// ---------------------------------------------------------------------------

describe("TS-001: keyword strategy routes simple complexity to tdd-simple", () => {
  test("simple story routes to tdd-simple (not test-after)", () => {
    const story = makeStory();
    const result = keywordRoute(story, cfg);

    expect(result).not.toBeNull();
    expect(result.complexity).toBe("simple");
    expect(result.testStrategy as string).toBe("tdd-simple");
  });

  test("story with 1 acceptance criterion is simple and routes to tdd-simple", () => {
    const story = makeStory({ acceptanceCriteria: ["It works"] });
    const result = keywordRoute(story, cfg);

    expect(result.complexity).toBe("simple");
    expect(result.testStrategy as string).toBe("tdd-simple");
  });

  test("story with 4 acceptance criteria (boundary) is simple and routes to tdd-simple", () => {
    const story = makeStory({
      acceptanceCriteria: ["AC1", "AC2", "AC3", "AC4"],
    });
    const result = keywordRoute(story, cfg);

    expect(result.complexity).toBe("simple");
    expect(result.testStrategy as string).toBe("tdd-simple");
  });

  test("simple story does NOT route to test-after", () => {
    const story = makeStory();
    const result = keywordRoute(story, cfg);

    expect(result.testStrategy as string).not.toBe("test-after");
  });

  test("non-security, non-public-api simple story uses tdd-simple", () => {
    const story = makeStory({
      title: "Update welcome message",
      description: "Change the copy on the landing page",
      tags: ["ui"],
    });
    const result = keywordRoute(story, cfg);

    expect(result.complexity).toBe("simple");
    expect(result.testStrategy as string).toBe("tdd-simple");
  });
});

// ---------------------------------------------------------------------------
// TS-001: other complexities retain their existing strategies
// ---------------------------------------------------------------------------

// #408: keyword fallback no longer produces "medium" (AC count removed).
// "medium" only comes from the plan LLM. keyword: simple | complex | expert.
describe("TS-001: other complexities retain their strategies (#408 thresholds)", () => {
  // #408: many ACs without keywords still routes to simple (AC count removed)
  test("story with many ACs but no keywords → simple + tdd-simple (#408)", () => {
    const story = makeStory({
      acceptanceCriteria: ["AC1", "AC2", "AC3", "AC4", "AC5"],
    });
    const result = keywordRoute(story, cfg);

    expect(result.complexity).toBe("simple");
    expect(result.testStrategy).toBe("tdd-simple");
  });

  // #408: complex keyword (non-security) → three-session-tdd-lite (was three-session-tdd)
  test("complex keyword story routes to three-session-tdd-lite (#408)", () => {
    const story = makeStory({
      title: "Redesign data pipeline module",
      acceptanceCriteria: ["AC1"],
    });
    const result = keywordRoute(story, cfg);

    expect(result.complexity).toBe("complex");
    expect(result.testStrategy).toBe("three-session-tdd-lite");
  });

  test("security keyword story routes to three-session-tdd regardless of complexity", () => {
    const story = makeStory({
      title: "Add JWT token validation",
      tags: ["auth"],
    });
    const result = keywordRoute(story, cfg);

    expect(result.testStrategy).toBe("three-session-tdd");
  });
});
