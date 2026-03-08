/**
 * TS-001: keyword strategy — tdd-simple test strategy type and routing
 *
 * Failing tests (RED phase):
 * - simple complexity must route to tdd-simple, not test-after
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { RoutingDecision } from "../../../../src/routing/strategy";
import { keywordStrategy } from "../../../../src/routing/strategies/keyword";
import type { RoutingContext } from "../../../../src/routing/strategy";
import type { UserStory } from "../../../../src/prd/types";
import { DEFAULT_CONFIG } from "../../../../src/config/defaults";
import { initLogger, resetLogger } from "../../../../src/logger";

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

const ctx: RoutingContext = {
  config: { ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing, llm: undefined } },
};

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
    const result = keywordStrategy.route(story, ctx) as RoutingDecision;

    expect(result).not.toBeNull();
    expect(result.complexity).toBe("simple");
    expect(result.testStrategy as string).toBe("tdd-simple");
  });

  test("story with 1 acceptance criterion is simple and routes to tdd-simple", () => {
    const story = makeStory({ acceptanceCriteria: ["It works"] });
    const result = keywordStrategy.route(story, ctx) as RoutingDecision;

    expect(result.complexity).toBe("simple");
    expect(result.testStrategy as string).toBe("tdd-simple");
  });

  test("story with 4 acceptance criteria (boundary) is simple and routes to tdd-simple", () => {
    const story = makeStory({
      acceptanceCriteria: ["AC1", "AC2", "AC3", "AC4"],
    });
    const result = keywordStrategy.route(story, ctx) as RoutingDecision;

    expect(result.complexity).toBe("simple");
    expect(result.testStrategy as string).toBe("tdd-simple");
  });

  test("simple story does NOT route to test-after", () => {
    const story = makeStory();
    const result = keywordStrategy.route(story, ctx) as RoutingDecision;

    expect(result.testStrategy as string).not.toBe("test-after");
  });

  test("non-security, non-public-api simple story uses tdd-simple", () => {
    const story = makeStory({
      title: "Update welcome message",
      description: "Change the copy on the landing page",
      tags: ["ui"],
    });
    const result = keywordStrategy.route(story, ctx) as RoutingDecision;

    expect(result.complexity).toBe("simple");
    expect(result.testStrategy as string).toBe("tdd-simple");
  });
});

// ---------------------------------------------------------------------------
// TS-001: other complexities retain their existing strategies
// ---------------------------------------------------------------------------

describe("TS-001: other complexities retain their strategies", () => {
  test("medium complexity story routes to three-session-tdd-lite", () => {
    const story = makeStory({
      acceptanceCriteria: ["AC1", "AC2", "AC3", "AC4", "AC5"],
    });
    const result = keywordStrategy.route(story, ctx) as RoutingDecision;

    expect(result.complexity).toBe("medium");
    expect(result.testStrategy).toBe("three-session-tdd-lite");
  });

  test("complex keyword story routes to three-session-tdd", () => {
    const story = makeStory({
      title: "Refactor authentication module",
      acceptanceCriteria: ["AC1"],
    });
    const result = keywordStrategy.route(story, ctx) as RoutingDecision;

    expect(result.testStrategy).toBe("three-session-tdd");
  });

  test("security keyword story routes to three-session-tdd regardless of complexity", () => {
    const story = makeStory({
      title: "Add JWT token validation",
      tags: ["auth"],
    });
    const result = keywordStrategy.route(story, ctx) as RoutingDecision;

    expect(result.testStrategy).toBe("three-session-tdd");
  });
});
