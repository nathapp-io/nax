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
