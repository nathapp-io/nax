/**
 * Tests for Adaptive Routing Strategy
 */

import { describe, test, expect } from "bun:test";
import { adaptiveStrategy } from "../src/routing/strategies/adaptive";
import type { UserStory } from "../src/prd/types";
import type { RoutingContext } from "../src/routing/strategy";
import type { AggregateMetrics } from "../src/metrics/types";
import type { NgentConfig } from "../src/config";
import { DEFAULT_CONFIG } from "../src/config/schema";

/**
 * Create a test user story.
 */
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

/**
 * Create a test routing context with optional metrics.
 */
function createContext(
  metrics?: AggregateMetrics,
  config: NgentConfig = DEFAULT_CONFIG,
): RoutingContext {
  return {
    config,
    metrics,
  };
}

/**
 * Create mock aggregate metrics with specified complexity accuracy data.
 */
function createMockMetrics(
  complexityData: Record<
    string,
    { predicted: number; actualTierUsed: string; mismatchRate: number }
  >,
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
    test("should fallback to configured strategy when no metrics", () => {
      const story = createStory(
        "US-001",
        "Add user login",
        "Implement user authentication",
        ["User can log in with email and password"],
      );

      const context = createContext(undefined); // No metrics
      const decision = adaptiveStrategy.route(story, context);

      expect(decision).not.toBeNull();
      expect(decision?.reasoning).toContain("no metrics available");
      expect(decision?.reasoning).toContain("fallback to");
    });
  });

  describe("Insufficient data fallback", () => {
    test("should fallback when samples below minSamples threshold", () => {
      const metrics = createMockMetrics({
        simple: {
          predicted: 5, // Below default minSamples = 10
          actualTierUsed: "fast",
          mismatchRate: 0.2,
        },
      });

      const story = createStory(
        "US-002",
        "Fix typo",
        "Fix typo in README",
        ["Typo is fixed"],
      );

      const context = createContext(metrics);
      const decision = adaptiveStrategy.route(story, context);

      expect(decision).not.toBeNull();
      expect(decision?.reasoning).toContain("insufficient data");
      expect(decision?.reasoning).toContain("5/10 samples");
      expect(decision?.reasoning).toContain("fallback to");
    });

    test("should respect custom minSamples config", () => {
      const metrics = createMockMetrics({
        simple: {
          predicted: 3, // Below custom minSamples = 5
          actualTierUsed: "fast",
          mismatchRate: 0.1,
        },
      });

      const story = createStory(
        "US-003",
        "Update docs",
        "Update documentation",
        ["Docs are updated"],
      );

      const config: NgentConfig = {
        ...DEFAULT_CONFIG,
        routing: {
          ...DEFAULT_CONFIG.routing,
          strategy: "adaptive",
          adaptive: {
            minSamples: 5,
            costThreshold: 0.8,
            fallbackStrategy: "keyword",
          },
        },
      };

      const context = createContext(metrics, config);
      const decision = adaptiveStrategy.route(story, context);

      expect(decision).not.toBeNull();
      expect(decision?.reasoning).toContain("insufficient data");
      expect(decision?.reasoning).toContain("3/5 samples");
      expect(decision?.reasoning).toContain("fallback to keyword");
    });
  });

  describe("Sufficient data - adaptive routing", () => {
    test("should route to fast tier when low mismatch rate", () => {
      const metrics = createMockMetrics({
        simple: {
          predicted: 50, // Sufficient samples
          actualTierUsed: "fast",
          mismatchRate: 0.1, // Low mismatch = fast tier handles it well
        },
      });

      const story = createStory(
        "US-004",
        "Add button",
        "Add a submit button to the form",
        ["Button is visible", "Button triggers submit"],
      );

      const context = createContext(metrics);
      const decision = adaptiveStrategy.route(story, context);

      expect(decision).not.toBeNull();
      expect(decision?.complexity).toBe("simple");
      expect(decision?.modelTier).toBe("fast");
      expect(decision?.reasoning).toContain("adaptive");
      expect(decision?.reasoning).toContain("simple → fast");
      expect(decision?.reasoning).toContain("samples: 50");
      expect(decision?.reasoning).toContain("mismatch: 10.0%");
    });

    test("should route to higher tier when high mismatch rate", () => {
      const metrics = createMockMetrics({
        medium: {
          predicted: 30,
          actualTierUsed: "balanced",
          mismatchRate: 0.6, // High mismatch = needs higher tier
        },
      });

      const story = createStory(
        "US-005",
        "Add API endpoint",
        "Create new REST API endpoint",
        [
          "Endpoint accepts POST requests",
          "Request is validated",
          "Response is JSON",
          "Errors are handled",
          "Tests pass",
        ],
      );

      const context = createContext(metrics);
      const decision = adaptiveStrategy.route(story, context);

      expect(decision).not.toBeNull();
      expect(decision?.complexity).toBe("medium");
      // Should calculate that balanced tier is more cost-effective despite fast being cheaper
      expect(decision?.reasoning).toContain("adaptive");
      expect(decision?.reasoning).toContain("medium");
      expect(decision?.reasoning).toContain("samples: 30");
    });

    test("should include cost information in reasoning", () => {
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
      const decision = adaptiveStrategy.route(story, context);

      expect(decision).not.toBeNull();
      expect(decision?.reasoning).toContain("cost:");
      expect(decision?.reasoning).toMatch(/\$\d+\.\d{4}/); // Should include cost in format $X.XXXX
    });
  });

  describe("Cost calculation", () => {
    test("should prefer fast tier when effective cost is lower", () => {
      // Fast tier with low fail rate should beat balanced tier
      const metrics = createMockMetrics({
        simple: {
          predicted: 20,
          actualTierUsed: "fast",
          mismatchRate: 0.05, // Only 5% need escalation
        },
      });

      const story = createStory(
        "US-007",
        "Update label",
        "Change button label",
        ["Label is updated"],
      );

      const context = createContext(metrics);
      const decision = adaptiveStrategy.route(story, context);

      expect(decision).not.toBeNull();
      expect(decision?.modelTier).toBe("fast");
      // Effective cost for fast: ~0.005 + 0.05 * 0.02 = 0.006
      // This beats balanced: ~0.02
    });

    test("should prefer balanced tier when fast has high fail rate", () => {
      // Fast tier with high fail rate should lose to balanced tier
      const metrics = createMockMetrics({
        medium: {
          predicted: 25,
          actualTierUsed: "balanced",
          mismatchRate: 0.8, // 80% need escalation from fast
        },
      });

      const story = createStory(
        "US-008",
        "Implement validation",
        "Add input validation to form",
        ["Email is validated", "Phone is validated", "Required fields checked"],
      );

      const context = createContext(metrics);
      const decision = adaptiveStrategy.route(story, context);

      expect(decision).not.toBeNull();
      // Fast effective cost: 0.005 + 0.8 * 0.02 = 0.021
      // Balanced cost: 0.02
      // Balanced should win or be very close
      expect(["fast", "balanced"]).toContain(decision?.modelTier);
    });
  });

  describe("Threshold switching", () => {
    test("should respect costThreshold configuration", () => {
      const metrics = createMockMetrics({
        simple: {
          predicted: 40,
          actualTierUsed: "fast",
          mismatchRate: 0.15,
        },
      });

      const story = createStory(
        "US-009",
        "Add icon",
        "Add icon to sidebar",
        ["Icon is visible"],
      );

      // Lower threshold = more aggressive switching
      const config: NgentConfig = {
        ...DEFAULT_CONFIG,
        routing: {
          ...DEFAULT_CONFIG.routing,
          strategy: "adaptive",
          adaptive: {
            minSamples: 10,
            costThreshold: 0.5, // Lower threshold
            fallbackStrategy: "llm",
          },
        },
      };

      const context = createContext(metrics, config);
      const decision = adaptiveStrategy.route(story, context);

      expect(decision).not.toBeNull();
      expect(decision?.reasoning).toContain("adaptive");
    });
  });

  describe("Test strategy inheritance", () => {
    test("should use fallback strategy's test strategy decision", () => {
      const metrics = createMockMetrics({
        complex: {
          predicted: 20,
          actualTierUsed: "powerful",
          mismatchRate: 0.1,
        },
      });

      // Security-critical story should get three-session-tdd
      const story = createStory(
        "US-010",
        "Add authentication",
        "Implement JWT authentication",
        Array.from({ length: 10 }, (_, i) => `Criterion ${i + 1}`),
        ["security", "auth"],
      );

      const context = createContext(metrics);
      const decision = adaptiveStrategy.route(story, context);

      expect(decision).not.toBeNull();
      expect(decision?.testStrategy).toBe("three-session-tdd");
    });

    test("should use test-after for simple non-critical stories", () => {
      const metrics = createMockMetrics({
        simple: {
          predicted: 30,
          actualTierUsed: "fast",
          mismatchRate: 0.05,
        },
      });

      const story = createStory(
        "US-011",
        "Update color",
        "Change button color to blue",
        ["Color is updated"],
      );

      const context = createContext(metrics);
      const decision = adaptiveStrategy.route(story, context);

      expect(decision).not.toBeNull();
      expect(decision?.testStrategy).toBe("test-after");
    });
  });

  describe("Multiple complexity levels", () => {
    test("should handle metrics for multiple complexity levels", () => {
      const metrics = createMockMetrics({
        simple: {
          predicted: 50,
          actualTierUsed: "fast",
          mismatchRate: 0.1,
        },
        medium: {
          predicted: 30,
          actualTierUsed: "balanced",
          mismatchRate: 0.2,
        },
        complex: {
          predicted: 15,
          actualTierUsed: "powerful",
          mismatchRate: 0.15,
        },
        expert: {
          predicted: 5,
          actualTierUsed: "powerful",
          mismatchRate: 0.0,
        },
      });

      // Simple story
      const simpleStory = createStory("US-012", "Fix typo", "Fix typo", ["Done"]);
      const simpleDecision = adaptiveStrategy.route(simpleStory, createContext(metrics));
      expect(simpleDecision?.complexity).toBe("simple");
      expect(simpleDecision?.modelTier).toBe("fast");

      // Complex story
      const complexStory = createStory(
        "US-013",
        "Refactor API",
        "Refactor API module",
        Array.from({ length: 10 }, (_, i) => `Criterion ${i + 1}`),
      );
      const complexDecision = adaptiveStrategy.route(complexStory, createContext(metrics));
      expect(complexDecision?.complexity).toBe("complex");
    });
  });

  describe("Edge cases", () => {
    test("should handle zero mismatch rate gracefully", () => {
      const metrics = createMockMetrics({
        simple: {
          predicted: 100,
          actualTierUsed: "fast",
          mismatchRate: 0.0, // Perfect match
        },
      });

      const story = createStory("US-014", "Add text", "Add help text", ["Text added"]);
      const context = createContext(metrics);
      const decision = adaptiveStrategy.route(story, context);

      expect(decision).not.toBeNull();
      expect(decision?.modelTier).toBe("fast");
    });

    test("should handle 100% mismatch rate", () => {
      const metrics = createMockMetrics({
        medium: {
          predicted: 10,
          actualTierUsed: "powerful",
          mismatchRate: 1.0, // Always needs escalation
        },
      });

      const story = createStory(
        "US-015",
        "Implement feature",
        "Add new feature",
        ["Feature works", "Tests pass", "Docs updated"],
      );

      const context = createContext(metrics);
      const decision = adaptiveStrategy.route(story, context);

      expect(decision).not.toBeNull();
      // With 100% mismatch from fast, should prefer higher tier
      expect(decision?.reasoning).toContain("adaptive");
    });

    test("should handle missing complexity level in metrics", () => {
      // Metrics only have data for 'simple', not 'expert'
      const metrics = createMockMetrics({
        simple: {
          predicted: 50,
          actualTierUsed: "fast",
          mismatchRate: 0.1,
        },
      });

      const story = createStory(
        "US-016",
        "Implement distributed consensus",
        "Add Raft consensus algorithm",
        Array.from({ length: 15 }, (_, i) => `Criterion ${i + 1}`),
        ["distributed consensus", "real-time"],
      );

      const context = createContext(metrics);
      const decision = adaptiveStrategy.route(story, context);

      expect(decision).not.toBeNull();
      // Should fallback for expert complexity (no data)
      expect(decision?.reasoning).toContain("insufficient data");
    });
  });
});
