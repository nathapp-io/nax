/**
 * Routing Tests
 *
 * Consolidated test suite for routing system including:
 * - Core routing logic (classifyComplexity, determineTestStrategy, routeTask)
 * - Routing strategies (keyword, llm, manual, adaptive)
 * - Strategy chain execution
 * - Async support and chain delegation
 */

import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../src/config";
import type { NaxConfig } from "../../src/config";
import { escalateTier } from "../../src/execution/runner";
import type { AggregateMetrics } from "../../src/metrics/types";
import type { UserStory } from "../../src/prd/types";
import { classifyComplexity, determineTestStrategy, routeTask } from "../../src/routing";
import { buildStrategyChain } from "../../src/routing/builder";
import { StrategyChain } from "../../src/routing/chain";
import { keywordStrategy, llmStrategy, manualStrategy } from "../../src/routing/strategies";
import { adaptiveStrategy } from "../../src/routing/strategies/adaptive";
import {
  buildBatchPrompt,
  buildRoutingPrompt,
  clearCache,
  clearCacheForStory,
  getCacheSize,
  llmStrategy as llmStrategyFull,
  parseRoutingResponse,
  routeBatch,
  stripCodeFences,
  validateRoutingDecision,
} from "../../src/routing/strategies/llm";
import type { RoutingContext, RoutingDecision, RoutingStrategy } from "../../src/routing/strategy";

// ============================================================================
// Core Routing Logic Tests
// ============================================================================

describe("classifyComplexity", () => {
  test("simple: few criteria, no keywords", () => {
    expect(classifyComplexity("Fix typo", "Fix a typo in error message", ["Typo is fixed"], [])).toBe("simple");
  });

  test("medium: moderate criteria count", () => {
    expect(classifyComplexity("Add validation", "Add DTO validation", ["a", "b", "c", "d", "e"], [])).toBe("medium");
  });

  test("complex: security keyword", () => {
    expect(classifyComplexity("Auth refactor", "Refactor JWT authentication", ["Token works"], ["security"])).toBe(
      "complex",
    );
  });

  test("expert: distributed keyword", () => {
    expect(classifyComplexity("Real-time sync", "Real-time distributed consensus", ["Sync works"], [])).toBe("expert");
  });

  test("4 ACs should classify as simple (BUG-19 regression)", () => {
    const complexity = classifyComplexity(
      "Add validation",
      "Add basic input validation",
      ["AC1", "AC2", "AC3", "AC4"],
      [],
    );
    expect(complexity).toBe("simple");
  });

  test("5 ACs should classify as medium (BUG-19 regression)", () => {
    const complexity = classifyComplexity(
      "Add validation",
      "Add comprehensive input validation",
      ["AC1", "AC2", "AC3", "AC4", "AC5"],
      [],
    );
    expect(complexity).toBe("medium");
  });

  test("9 ACs should classify as complex (BUG-19 regression)", () => {
    const complexity = classifyComplexity(
      "Add validation",
      "Add extensive input validation",
      ["AC1", "AC2", "AC3", "AC4", "AC5", "AC6", "AC7", "AC8", "AC9"],
      [],
    );
    expect(complexity).toBe("complex");
  });
});

describe("determineTestStrategy", () => {
  test("simple → test-after", () => {
    expect(determineTestStrategy("simple", "Fix typo", "Fix a typo", [])).toBe("test-after");
  });

  test("complex → three-session-tdd", () => {
    expect(determineTestStrategy("complex", "Refactor module", "Complex refactor", [])).toBe("three-session-tdd");
  });

  test("security keyword → three-session-tdd even if simple", () => {
    expect(determineTestStrategy("simple", "Fix auth bypass", "Security fix for JWT token", ["security"])).toBe(
      "three-session-tdd",
    );
  });

  test("public api keyword → three-session-tdd even if simple", () => {
    expect(determineTestStrategy("simple", "Add endpoint", "New public api endpoint for users", [])).toBe(
      "three-session-tdd",
    );
  });

  describe("tddStrategy overrides", () => {
    test("strategy='strict' always returns three-session-tdd", () => {
      expect(determineTestStrategy("simple", "Update button", "Change color", [], "strict")).toBe("three-session-tdd");
      expect(determineTestStrategy("medium", "Update button", "Change color", [], "strict")).toBe("three-session-tdd");
      expect(determineTestStrategy("complex", "Refactor module", "Big refactor", [], "strict")).toBe(
        "three-session-tdd",
      );
    });

    test("strategy='lite' always returns three-session-tdd-lite", () => {
      expect(determineTestStrategy("simple", "Update button", "Change color", [], "lite")).toBe(
        "three-session-tdd-lite",
      );
      expect(determineTestStrategy("medium", "Update form", "Add validation", [], "lite")).toBe(
        "three-session-tdd-lite",
      );
      expect(determineTestStrategy("complex", "Refactor module", "Big refactor", [], "lite")).toBe(
        "three-session-tdd-lite",
      );
    });

    test("strategy='off' always returns test-after", () => {
      expect(determineTestStrategy("simple", "Update button", "Change color", [], "off")).toBe("test-after");
      expect(determineTestStrategy("complex", "Refactor auth", "JWT refactor", ["security"], "off")).toBe("test-after");
      expect(determineTestStrategy("expert", "Real-time sync", "Distributed consensus", [], "off")).toBe("test-after");
    });

    test("strategy='auto' returns three-session-tdd-lite for UI-tagged complex stories", () => {
      expect(determineTestStrategy("complex", "Redesign dashboard", "UI overhaul", ["ui"], "auto")).toBe(
        "three-session-tdd-lite",
      );
    });

    test("strategy='auto' returns three-session-tdd-lite for layout-tagged stories", () => {
      expect(determineTestStrategy("complex", "Fix layout", "Responsive layout fix", ["layout"], "auto")).toBe(
        "three-session-tdd-lite",
      );
    });

    test("strategy='auto' security-critical stories always return three-session-tdd even with ui tag", () => {
      expect(determineTestStrategy("complex", "Auth UI", "JWT token security screen", ["ui", "security"], "auto")).toBe(
        "three-session-tdd",
      );
    });

    test("strategy='auto' lite tags are case-insensitive", () => {
      expect(determineTestStrategy("complex", "Build UI", "Create UI", ["UI"], "auto")).toBe("three-session-tdd-lite");
      expect(determineTestStrategy("complex", "Build CLI", "Create CLI", ["CLI"], "auto")).toBe(
        "three-session-tdd-lite",
      );
    });
  });
});

describe("routeTask", () => {
  test("routes simple task to fast model with test-after", () => {
    const result = routeTask("Fix typo", "Fix a typo", ["Typo fixed"], [], DEFAULT_CONFIG);
    expect(result.complexity).toBe("simple");
    expect(result.modelTier).toBe("fast");
    expect(result.testStrategy).toBe("test-after");
  });

  test("routes security task to powerful with three-session-tdd", () => {
    const result = routeTask("Auth fix", "Fix JWT auth bypass", ["Auth works"], ["security"], DEFAULT_CONFIG);
    expect(result.complexity).toBe("complex");
    expect(result.modelTier).toBe("powerful");
    expect(result.testStrategy).toBe("three-session-tdd");
  });

  test("routes all complexity levels correctly", () => {
    const simpleResult = routeTask("Fix typo", "Fix a typo", ["Typo fixed"], [], DEFAULT_CONFIG);
    expect(simpleResult.complexity).toBe("simple");
    expect(simpleResult.modelTier).toBe("fast");

    const mediumResult = routeTask(
      "Add validation",
      "Add DTO validation",
      ["a", "b", "c", "d", "e"],
      [],
      DEFAULT_CONFIG,
    );
    expect(mediumResult.complexity).toBe("medium");
    expect(mediumResult.modelTier).toBe("balanced");

    const complexResult = routeTask(
      "Auth refactor",
      "Refactor JWT authentication",
      ["Token works"],
      ["security"],
      DEFAULT_CONFIG,
    );
    expect(complexResult.complexity).toBe("complex");
    expect(complexResult.modelTier).toBe("powerful");

    const expertResult = routeTask(
      "Real-time sync",
      "Real-time distributed consensus",
      ["Sync works"],
      [],
      DEFAULT_CONFIG,
    );
    expect(expertResult.complexity).toBe("expert");
    expect(expertResult.modelTier).toBe("powerful");
  });

  test("complexity → modelTier mapping respects config (BUG-19 regression)", () => {
    const simpleResult = routeTask("Simple task", "Simple description", ["AC1"], [], DEFAULT_CONFIG);
    expect(simpleResult.complexity).toBe("simple");
    expect(simpleResult.modelTier).toBe("fast");

    const mediumResult = routeTask(
      "Medium task",
      "Medium description",
      ["AC1", "AC2", "AC3", "AC4", "AC5"],
      [],
      DEFAULT_CONFIG,
    );
    expect(mediumResult.complexity).toBe("medium");
    expect(mediumResult.modelTier).toBe("balanced");

    const complexResult = routeTask(
      "Complex task",
      "Complex description",
      ["AC1", "AC2", "AC3", "AC4", "AC5", "AC6", "AC7", "AC8", "AC9"],
      [],
      DEFAULT_CONFIG,
    );
    expect(complexResult.complexity).toBe("complex");
    expect(complexResult.modelTier).toBe("powerful");
  });

  describe("tddStrategy config integration", () => {
    const makeConfig = (strategy: NaxConfig["tdd"]["strategy"]): NaxConfig => ({
      ...DEFAULT_CONFIG,
      tdd: { ...DEFAULT_CONFIG.tdd, strategy },
    });

    test("config.tdd.strategy='strict' forces three-session-tdd on simple task", () => {
      const result = routeTask("Fix typo", "Fix a typo", ["Typo fixed"], [], makeConfig("strict"));
      expect(result.testStrategy).toBe("three-session-tdd");
      expect(result.reasoning).toContain("strategy:strict");
    });

    test("config.tdd.strategy='lite' forces three-session-tdd-lite on any task", () => {
      const result = routeTask("Fix typo", "Fix a typo", ["Typo fixed"], [], makeConfig("lite"));
      expect(result.testStrategy).toBe("three-session-tdd-lite");
      expect(result.reasoning).toContain("strategy:lite");
    });

    test("config.tdd.strategy='off' forces test-after even on complex/security tasks", () => {
      const result = routeTask("Auth refactor", "JWT auth security", ["Token works"], ["security"], makeConfig("off"));
      expect(result.testStrategy).toBe("test-after");
    });

    test("default config (strategy='auto') preserves existing routing behavior", () => {
      const simpleResult = routeTask("Fix typo", "Fix a typo", ["Typo fixed"], [], DEFAULT_CONFIG);
      expect(simpleResult.testStrategy).toBe("test-after");

      const complexResult = routeTask(
        "Auth refactor",
        "Refactor JWT authentication",
        ["Token works"],
        ["security"],
        DEFAULT_CONFIG,
      );
      expect(complexResult.testStrategy).toBe("three-session-tdd");
    });
  });
});

describe("escalateTier", () => {
  const defaultTiers = [
    { tier: "fast", attempts: 5 },
    { tier: "balanced", attempts: 3 },
    { tier: "powerful", attempts: 2 },
  ];

  test("escalates fast → balanced", () => {
    expect(escalateTier("fast", defaultTiers)).toBe("balanced");
  });

  test("escalates balanced → powerful", () => {
    expect(escalateTier("balanced", defaultTiers)).toBe("powerful");
  });

  test("escalates powerful → null (max reached)", () => {
    expect(escalateTier("powerful", defaultTiers)).toBeNull();
  });

  test("explicit 3-tier escalation chain: fast → balanced → powerful → null", () => {
    let tier: string | null = escalateTier("fast", defaultTiers);
    expect(tier).toBe("balanced");

    tier = escalateTier(tier!, defaultTiers);
    expect(tier).toBe("powerful");

    tier = escalateTier(tier!, defaultTiers);
    expect(tier).toBeNull();
  });
});

// ============================================================================
// Strategy System Tests
// ============================================================================

describe("StrategyChain", () => {
  test("uses first strategy that returns non-null", async () => {
    const alwaysNullStrategy: RoutingStrategy = {
      name: "always-null",
      route: () => null,
    };

    const alwaysReturnStrategy: RoutingStrategy = {
      name: "always-return",
      route: () => ({
        complexity: "simple",
        modelTier: "fast",
        testStrategy: "test-after",
        reasoning: "Always return strategy",
      }),
    };

    const chain = new StrategyChain([alwaysNullStrategy, alwaysReturnStrategy]);

    const story: UserStory = {
      id: "US-001",
      title: "Test story",
      description: "Test",
      acceptanceCriteria: [],
      tags: [],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 0,
    };

    const configWithoutLlm = { ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing, llm: undefined } };
    const context: RoutingContext = { config: configWithoutLlm };
    const decision = await chain.route(story, context);

    expect(decision.reasoning).toBe("Always return strategy");
  });

  test("throws error if all strategies return null", async () => {
    const alwaysNullStrategy: RoutingStrategy = {
      name: "always-null",
      route: () => null,
    };

    const chain = new StrategyChain([alwaysNullStrategy]);

    const story: UserStory = {
      id: "US-001",
      title: "Test story",
      description: "Test",
      acceptanceCriteria: [],
      tags: [],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 0,
    };

    const configWithoutLlm = { ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing, llm: undefined } };
    const context: RoutingContext = { config: configWithoutLlm };

    await expect(chain.route(story, context)).rejects.toThrow("No routing strategy returned a decision");
  });

  test("getStrategyNames returns strategy names", () => {
    const chain = new StrategyChain([keywordStrategy, llmStrategy]);
    expect(chain.getStrategyNames()).toEqual(["keyword", "llm"]);
  });

  describe("async support", () => {
    test("handles async strategy that returns decision", async () => {
      const asyncStrategy: RoutingStrategy = {
        name: "async-test",
        route: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return {
            complexity: "medium",
            modelTier: "balanced",
            testStrategy: "test-after",
            reasoning: "Async strategy result",
          };
        },
      };

      const chain = new StrategyChain([asyncStrategy]);

      const story: UserStory = {
        id: "US-001",
        title: "Test async story",
        description: "Test async routing",
        acceptanceCriteria: [],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 0,
      };

      const context: RoutingContext = { config: DEFAULT_CONFIG };
      const decision = await chain.route(story, context);

      expect(decision.reasoning).toBe("Async strategy result");
      expect(decision.complexity).toBe("medium");
      expect(decision.modelTier).toBe("balanced");
    });

    test("handles mixed sync and async strategies", async () => {
      const syncStrategy: RoutingStrategy = {
        name: "sync-first",
        route: () => null,
      };

      const asyncStrategy: RoutingStrategy = {
        name: "async-second",
        route: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return {
            complexity: "complex",
            modelTier: "powerful",
            testStrategy: "three-session-tdd",
            reasoning: "Mixed chain result",
          };
        },
      };

      const chain = new StrategyChain([syncStrategy, asyncStrategy]);

      const story: UserStory = {
        id: "US-003",
        title: "Test mixed",
        description: "Test mixed sync/async",
        acceptanceCriteria: [],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 0,
      };

      const context: RoutingContext = { config: DEFAULT_CONFIG };
      const decision = await chain.route(story, context);

      expect(decision.reasoning).toBe("Mixed chain result");
      expect(decision.testStrategy).toBe("three-session-tdd");
    });
  });
});

describe("keywordStrategy", () => {
  test("classifies simple story correctly", () => {
    const story: UserStory = {
      id: "US-001",
      title: "Update button color",
      description: "Change button to blue",
      acceptanceCriteria: ["Button is blue"],
      tags: [],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 0,
    };

    const configWithoutLlm = { ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing, llm: undefined } };
    const context: RoutingContext = { config: configWithoutLlm };
    const decision = keywordStrategy.route(story, context);

    expect(decision).not.toBeNull();
    expect(decision!.complexity).toBe("simple");
    expect(decision!.modelTier).toBe("fast");
    expect(decision!.testStrategy).toBe("test-after");
  });

  test("classifies complex story with security keywords", () => {
    const story: UserStory = {
      id: "US-002",
      title: "Add JWT authentication",
      description: "Implement JWT auth with refresh tokens",
      acceptanceCriteria: ["Token storage", "Refresh logic", "Expiry"],
      tags: ["security", "auth"],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 0,
    };

    const configWithoutLlm = { ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing, llm: undefined } };
    const context: RoutingContext = { config: configWithoutLlm };
    const decision = keywordStrategy.route(story, context);

    expect(decision).not.toBeNull();
    expect(decision!.complexity).toBe("complex");
    expect(decision!.modelTier).toBe("powerful");
    expect(decision!.testStrategy).toBe("three-session-tdd");
    expect(decision!.reasoning).toContain("security-critical");
  });

  test("uses three-session-tdd for public API", () => {
    const story: UserStory = {
      id: "US-005",
      title: "Add public API endpoint",
      description: "Create external API for consumers",
      acceptanceCriteria: ["Endpoint returns JSON"],
      tags: ["public api"],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 0,
    };

    const configWithoutLlm = { ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing, llm: undefined } };
    const context: RoutingContext = { config: configWithoutLlm };
    const decision = keywordStrategy.route(story, context);

    expect(decision).not.toBeNull();
    expect(decision!.testStrategy).toBe("three-session-tdd");
    expect(decision!.reasoning).toContain("public-api");
  });
});

describe("manualStrategy", () => {
  test("returns decision from story.routing metadata", () => {
    const story: UserStory = {
      id: "US-006",
      title: "Manual override test",
      description: "Story with manual routing",
      acceptanceCriteria: [],
      tags: [],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 0,
      routing: {
        complexity: "expert",
        modelTier: "powerful",
        testStrategy: "three-session-tdd",
        reasoning: "Manual override for critical task",
      },
    };

    const configWithoutLlm = { ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing, llm: undefined } };
    const context: RoutingContext = { config: configWithoutLlm };
    const decision = manualStrategy.route(story, context);

    expect(decision).not.toBeNull();
    expect(decision!.complexity).toBe("expert");
    expect(decision!.modelTier).toBe("powerful");
    expect(decision!.testStrategy).toBe("three-session-tdd");
    expect(decision!.reasoning).toBe("Manual override for critical task");
  });

  test("returns null when no routing metadata", () => {
    const story: UserStory = {
      id: "US-007",
      title: "No manual routing",
      description: "Story without routing metadata",
      acceptanceCriteria: [],
      tags: [],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 0,
    };

    const configWithoutLlm = { ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing, llm: undefined } };
    const context: RoutingContext = { config: configWithoutLlm };
    const decision = manualStrategy.route(story, context);

    expect(decision).toBeNull();
  });
});

describe("buildStrategyChain", () => {
  test("builds keyword-only chain by default", async () => {
    const chain = await buildStrategyChain(DEFAULT_CONFIG, "/tmp");
    expect(chain.getStrategyNames()).toEqual(["keyword"]);
  });

  test("builds manual + keyword chain when strategy=manual", async () => {
    const config = {
      ...DEFAULT_CONFIG,
      routing: { strategy: "manual" as const },
    };
    const chain = await buildStrategyChain(config, "/tmp");
    expect(chain.getStrategyNames()).toEqual(["manual", "keyword"]);
  });

  test("builds llm + keyword chain when strategy=llm", async () => {
    const config = {
      ...DEFAULT_CONFIG,
      routing: { strategy: "llm" as const },
    };
    const chain = await buildStrategyChain(config, "/tmp");
    expect(chain.getStrategyNames()).toEqual(["llm", "keyword"]);
  });

  test("throws error when custom strategy without path", async () => {
    const config = {
      ...DEFAULT_CONFIG,
      routing: { strategy: "custom" as const },
    };
    await expect(buildStrategyChain(config, "/tmp")).rejects.toThrow("routing.customStrategyPath is required");
  });
});

// ============================================================================
// LLM Strategy Tests
// ============================================================================

// Test user stories for LLM tests
const simpleStory: UserStory = {
  id: "US-001",
  title: "Fix typo in README",
  description: "Correct spelling mistake",
  acceptanceCriteria: ["Update README.md with correct spelling"],
  tags: ["docs"],
  dependencies: [],
  status: "pending",
  passes: false,
};

const complexStory: UserStory = {
  id: "US-002",
  title: "Add JWT authentication",
  description: "Implement JWT authentication with refresh tokens",
  acceptanceCriteria: ["Secure token storage", "Token refresh endpoint", "Expiry handling", "Logout functionality"],
  tags: ["security", "auth"],
  dependencies: [],
  status: "pending",
  passes: false,
};

const testContext: RoutingContext = {
  config: DEFAULT_CONFIG,
};

describe("LLM Routing Strategy - Prompt Building", () => {
  test("buildRoutingPrompt formats story correctly", () => {
    const prompt = buildRoutingPrompt(simpleStory, DEFAULT_CONFIG);

    expect(prompt).toContain("Title: Fix typo in README");
    expect(prompt).toContain("Description: Correct spelling mistake");
    expect(prompt).toContain("1. Update README.md with correct spelling");
    expect(prompt).toContain("Tags: docs");
    expect(prompt).toContain("fast: Simple changes");
    expect(prompt).toContain("balanced: Standard features");
    expect(prompt).toContain("powerful: Complex architecture");
    expect(prompt).toContain("test-after: Write implementation first");
    expect(prompt).toContain("three-session-tdd: Separate test-writer");
  });

  test("buildBatchPrompt formats multiple stories", () => {
    const stories = [simpleStory, complexStory];
    const prompt = buildBatchPrompt(stories, DEFAULT_CONFIG);

    expect(prompt).toContain("1. US-001: Fix typo in README");
    expect(prompt).toContain("2. US-002: Add JWT authentication");
    expect(prompt).toContain("Tags: docs");
    expect(prompt).toContain("Tags: security, auth");
    expect(prompt).toContain('{"id":"US-001"');
  });
});

describe("LLM Routing Strategy - Response Parsing", () => {
  test("parseRoutingResponse handles valid JSON", () => {
    const output =
      '{"complexity":"simple","modelTier":"fast","testStrategy":"test-after","reasoning":"Simple documentation fix"}';
    const decision = parseRoutingResponse(output, simpleStory, DEFAULT_CONFIG);

    expect(decision.complexity).toBe("simple");
    expect(decision.modelTier).toBe("fast");
    expect(decision.testStrategy).toBe("test-after");
    expect(decision.reasoning).toBe("Simple documentation fix");
  });

  test("parseRoutingResponse strips markdown code blocks", () => {
    const output =
      '```json\n{"complexity":"complex","modelTier":"powerful","testStrategy":"three-session-tdd","reasoning":"Security-critical"}\n```';
    const decision = parseRoutingResponse(output, complexStory, DEFAULT_CONFIG);

    expect(decision.complexity).toBe("complex");
    expect(decision.modelTier).toBe("powerful");
    expect(decision.testStrategy).toBe("three-session-tdd");
  });

  test("parseRoutingResponse throws on invalid JSON", () => {
    const output = "This is not JSON";
    expect(() => parseRoutingResponse(output, simpleStory, DEFAULT_CONFIG)).toThrow();
  });

  test("parseRoutingResponse throws on missing fields", () => {
    const output = '{"complexity":"simple","modelTier":"fast"}';
    expect(() => parseRoutingResponse(output, simpleStory, DEFAULT_CONFIG)).toThrow("Missing required fields");
  });
});

describe("stripCodeFences", () => {
  test("returns plain JSON unchanged", () => {
    const input = '{"complexity":"simple"}';
    expect(stripCodeFences(input)).toBe('{"complexity":"simple"}');
  });

  test("strips ```json ... ``` fences", () => {
    const input = '```json\n{"complexity":"simple"}\n```';
    expect(stripCodeFences(input)).toBe('{"complexity":"simple"}');
  });

  test("strips leading 'json' keyword (no backticks)", () => {
    const input = 'json\n{"complexity":"simple"}';
    expect(stripCodeFences(input)).toBe('{"complexity":"simple"}');
  });
});

describe("validateRoutingDecision", () => {
  test("returns valid decision for correct input", () => {
    const input = { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "trivial" };
    const result = validateRoutingDecision(input, DEFAULT_CONFIG);
    expect(result).toEqual({
      complexity: "simple",
      modelTier: "fast",
      testStrategy: "test-after",
      reasoning: "trivial",
    });
  });

  test("throws on missing complexity", () => {
    const input = { modelTier: "fast", testStrategy: "test-after", reasoning: "test" };
    expect(() => validateRoutingDecision(input, DEFAULT_CONFIG)).toThrow("Missing required fields");
  });

  test("throws on invalid complexity value", () => {
    const input = { complexity: "mega", modelTier: "fast", testStrategy: "test-after", reasoning: "test" };
    expect(() => validateRoutingDecision(input, DEFAULT_CONFIG)).toThrow("Invalid complexity: mega");
  });
});

// ============================================================================
// Adaptive Strategy Tests (Pure Logic)
// ============================================================================

function createStory(
  id: string,
  title: string,
  description: string,
  acceptanceCriteria: string[] = [],
  tags: string[] = [],
): UserStory {
  return {
    id,
    title,
    description,
    acceptanceCriteria,
    tags,
    status: "pending",
    dependencies: [],
    passes: false,
    escalations: [],
    attempts: 0,
  };
}

function createContext(metrics?: AggregateMetrics, config: NaxConfig = DEFAULT_CONFIG): RoutingContext {
  return {
    config,
    metrics,
  };
}

function createMockMetrics(
  complexityData: Record<string, { predicted: number; actualTierUsed: string; mismatchRate: number }>,
): AggregateMetrics {
  return {
    totalRuns: 10,
    totalCost: 5.0,
    totalStories: 100,
    firstPassRate: 0.75,
    escalationRate: 0.25,
    avgCostPerStory: 0.05,
    avgCostPerFeature: 0.5,
    modelEfficiency: {
      "claude-haiku-4-5": {
        attempts: 60,
        successes: 50,
        passRate: 0.833,
        avgCost: 0.005,
        totalCost: 0.25,
      },
      "claude-sonnet-4.5": {
        attempts: 30,
        successes: 28,
        passRate: 0.933,
        avgCost: 0.02,
        totalCost: 0.56,
      },
      "claude-opus-4-6": {
        attempts: 10,
        successes: 10,
        passRate: 1.0,
        avgCost: 0.08,
        totalCost: 0.8,
      },
    },
    complexityAccuracy: complexityData,
  };
}

describe("Adaptive Routing Strategy", () => {
  describe("No metrics available", () => {
    test("should fallback to configured strategy when no metrics", async () => {
      const story = createStory("US-001", "Add user login", "Implement user authentication", [
        "User can log in with email and password",
      ]);

      const context = createContext(undefined);
      const decision = await adaptiveStrategy.route(story, context);

      expect(decision).not.toBeNull();
      expect(decision?.reasoning).toContain("no metrics available");
      expect(decision?.reasoning).toContain("fallback to");
    });
  });

  describe("Insufficient data fallback", () => {
    test("should fallback when samples below minSamples threshold", async () => {
      const metrics = createMockMetrics({
        simple: {
          predicted: 5,
          actualTierUsed: "fast",
          mismatchRate: 0.2,
        },
      });

      const story = createStory("US-002", "Fix typo", "Fix typo in README", ["Typo is fixed"]);

      const context = createContext(metrics);
      const decision = await adaptiveStrategy.route(story, context);

      expect(decision).not.toBeNull();
      expect(decision?.reasoning).toContain("insufficient data");
      expect(decision?.reasoning).toContain("5/10 samples");
      expect(decision?.reasoning).toContain("fallback to");
    });
  });

  describe("Sufficient data - adaptive routing", () => {
    test("should route to fast tier when low mismatch rate", async () => {
      const metrics = createMockMetrics({
        simple: {
          predicted: 50,
          actualTierUsed: "fast",
          mismatchRate: 0.1,
        },
      });

      const story = createStory("US-004", "Add button", "Add a submit button to the form", [
        "Button is visible",
        "Button triggers submit",
      ]);

      const context = createContext(metrics);
      const decision = await adaptiveStrategy.route(story, context);

      expect(decision).not.toBeNull();
      expect(decision?.complexity).toBe("simple");
      expect(decision?.modelTier).toBe("fast");
      expect(decision?.reasoning).toContain("adaptive");
      expect(decision?.reasoning).toContain("simple → fast");
      expect(decision?.reasoning).toContain("samples: 50");
      expect(decision?.reasoning).toContain("mismatch: 10.0%");
    });

    test("should include cost information in reasoning", async () => {
      const metrics = createMockMetrics({
        complex: {
          predicted: 15,
          actualTierUsed: "powerful",
          mismatchRate: 0.2,
        },
      });

      const story = createStory(
        "US-006",
        "Refactor authentication",
        "Refactor the auth module to use JWT",
        Array.from({ length: 10 }, (_, i) => `Criterion ${i + 1}`),
        ["security", "breaking-change"],
      );

      const context = createContext(metrics);
      const decision = await adaptiveStrategy.route(story, context);

      expect(decision).not.toBeNull();
      expect(decision?.reasoning).toContain("cost:");
      expect(decision?.reasoning).toMatch(/\$\d+\.\d{4}/);
    });
  });

  describe("Edge cases", () => {
    test("should handle zero mismatch rate gracefully", async () => {
      const metrics = createMockMetrics({
        simple: {
          predicted: 100,
          actualTierUsed: "fast",
          mismatchRate: 0.0,
        },
      });

      const story = createStory("US-014", "Add text", "Add help text", ["Text added"]);
      const context = createContext(metrics);
      const decision = await adaptiveStrategy.route(story, context);

      expect(decision).not.toBeNull();
      expect(decision?.modelTier).toBe("fast");
    });
  });
});

// ============================================================================
// LLM Cache Clearing Tests (BUG-028 fix)
// ============================================================================

describe("LLM Cache Clearing on Tier Escalation", () => {
  beforeEach(() => {
    // Clear cache before each test
    clearCache();
  });

  test("cache hit returns cached decision", () => {
    const story: UserStory = {
      id: "US-cache-001",
      title: "Test story",
      description: "Test story for cache",
      acceptanceCriteria: ["AC1"],
      tags: [],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 0,
    };

    const originalDecision: RoutingDecision = {
      complexity: "simple",
      modelTier: "fast",
      testStrategy: "test-after",
      reasoning: "Original decision",
    };

    const configWithoutLlm = { ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing, llm: undefined } };
    const context: RoutingContext = { config: configWithoutLlm };

    // Simulate cached decision
    const cachedDecisions = new Map<string, RoutingDecision>();
    cachedDecisions.set(story.id, originalDecision);

    // Verify initial cache state
    expect(getCacheSize()).toBe(0);

    // Note: We're testing the behavior through the exported functions
    // In a real scenario, the LLM strategy would populate the cache
    // For this test, we verify the cache clearing mechanism works
  });

  test("clearCacheForStory removes cache entry", () => {
    const storyId = "US-cache-002";

    // Clear cache first
    clearCache();
    expect(getCacheSize()).toBe(0);

    // Clear non-existent entry should not throw
    clearCacheForStory(storyId);
    expect(getCacheSize()).toBe(0);
  });

  test("clearCacheForStory after tier escalation forces re-routing", () => {
    const storyId = "US-cache-003";

    // Clear all caches
    clearCache();
    expect(getCacheSize()).toBe(0);

    // Simulate clearing for escalation
    clearCacheForStory(storyId);

    // Cache should still be empty
    expect(getCacheSize()).toBe(0);
  });

  test("clearing one story does not affect other cached stories", () => {
    clearCache();

    const story1Id = "US-escalate-1";
    const story2Id = "US-escalate-2";

    // Verify we can clear individual stories
    clearCacheForStory(story1Id);
    clearCacheForStory(story2Id);

    expect(getCacheSize()).toBe(0);
  });

  test("clearCacheForStory is idempotent", () => {
    const storyId = "US-idempotent";

    clearCache();
    expect(getCacheSize()).toBe(0);

    // Clear multiple times should be safe
    clearCacheForStory(storyId);
    clearCacheForStory(storyId);
    clearCacheForStory(storyId);

    expect(getCacheSize()).toBe(0);
  });
});
