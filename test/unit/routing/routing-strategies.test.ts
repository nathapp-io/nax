// RE-ARCH: keep
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
import { DEFAULT_CONFIG } from "../../../src/config";
import type { NaxConfig } from "../../../src/config";
import { escalateTier } from "../../../src/execution/runner";
import type { AggregateMetrics } from "../../../src/metrics/types";
import type { UserStory } from "../../../src/prd/types";
import { classifyComplexity, determineTestStrategy, routeTask } from "../../../src/routing";
import { buildStrategyChain } from "../../../src/routing/builder";
import { StrategyChain } from "../../../src/routing/chain";
import { keywordStrategy, llmStrategy, manualStrategy } from "../../../src/routing/strategies";
import { adaptiveStrategy } from "../../../src/routing/strategies/adaptive";
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
} from "../../../src/routing/strategies/llm";
import type { RoutingContext, RoutingDecision, RoutingStrategy } from "../../../src/routing/strategy";


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
    expect(decision!.testStrategy).toBe("tdd-simple");
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

describe("LLM Routing Strategy - Prompt Building", () => {
  test("buildRoutingPrompt formats story correctly", () => {
    const prompt = buildRoutingPrompt(simpleStory, DEFAULT_CONFIG);

    expect(prompt).toContain("Title: Fix typo in README");
    expect(prompt).toContain("Description: Correct spelling mistake");
    expect(prompt).toContain("1. Update README.md with correct spelling");
    expect(prompt).toContain("Tags: docs");
    expect(prompt).toContain("fast: For simple tasks");
    expect(prompt).toContain("balanced: For medium tasks");
    expect(prompt).toContain("powerful: For complex/expert tasks");
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
    expect(decision.testStrategy).toBe("tdd-simple");
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
      testStrategy: "tdd-simple",
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
