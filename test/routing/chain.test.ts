/**
 * Strategy Chain Async Tests
 *
 * Tests for async strategy chain execution (v0.8 LLM routing support)
 */

import { describe, test, expect } from "bun:test";
import type { UserStory } from "../../src/prd/types";
import type { RoutingStrategy, RoutingContext } from "../../src/routing/strategy";
import { StrategyChain } from "../../src/routing/chain";
import { DEFAULT_CONFIG } from "../../src/config/schema";

describe("StrategyChain async support", () => {
  test("handles async strategy that returns decision", async () => {
    const asyncStrategy: RoutingStrategy = {
      name: "async-test",
      route: async () => {
        // Simulate async work (e.g., LLM call)
        await new Promise(resolve => setTimeout(resolve, 10));
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

  test("handles async strategy that returns null (delegates)", async () => {
    const asyncNullStrategy: RoutingStrategy = {
      name: "async-null",
      route: async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return null;
      },
    };

    const syncFallbackStrategy: RoutingStrategy = {
      name: "sync-fallback",
      route: () => ({
        complexity: "simple",
        modelTier: "fast",
        testStrategy: "test-after",
        reasoning: "Fallback strategy",
      }),
    };

    const chain = new StrategyChain([asyncNullStrategy, syncFallbackStrategy]);

    const story: UserStory = {
      id: "US-002",
      title: "Test delegation",
      description: "Test async null delegation",
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

    expect(decision.reasoning).toBe("Fallback strategy");
  });

  test("handles mixed sync and async strategies", async () => {
    const syncStrategy: RoutingStrategy = {
      name: "sync-first",
      route: () => null,
    };

    const asyncStrategy: RoutingStrategy = {
      name: "async-second",
      route: async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
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

  test("throws error if all async strategies return null", async () => {
    const asyncNullStrategy1: RoutingStrategy = {
      name: "async-null-1",
      route: async () => {
        await new Promise(resolve => setTimeout(resolve, 5));
        return null;
      },
    };

    const asyncNullStrategy2: RoutingStrategy = {
      name: "async-null-2",
      route: async () => {
        await new Promise(resolve => setTimeout(resolve, 5));
        return null;
      },
    };

    const chain = new StrategyChain([asyncNullStrategy1, asyncNullStrategy2]);

    const story: UserStory = {
      id: "US-004",
      title: "Test all null",
      description: "Test all strategies return null",
      acceptanceCriteria: [],
      tags: [],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 0,
    };

    const context: RoutingContext = { config: DEFAULT_CONFIG };

    await expect(chain.route(story, context)).rejects.toThrow(
      "No routing strategy returned a decision"
    );
  });
});
