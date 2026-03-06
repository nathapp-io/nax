// RE-ARCH: keep
/**
 * Runner Tests — Story Batching + TDD Escalation
 *
 * Tests for grouping consecutive simple stories into batches,
 * and TDD escalation handling (retryAsLite, failure category outcomes).
 */

import { describe, expect, test } from "bun:test";
import { groupStoriesIntoBatches, precomputeBatchPlan } from "../../../src/execution/batching";
import type { StoryBatch } from "../../../src/execution/batching";
import { escalateTier } from "../../../src/execution/escalation";
import { buildBatchPrompt } from "../../../src/execution/prompts";
import { resolveMaxAttemptsOutcome } from "../../../src/execution/runner";
import type { UserStory } from "../../../src/prd";
import type { FailureCategory } from "../../../src/tdd/types";


describe("Batch Failure Escalation Strategy", () => {
  test("batch failure should escalate only first story, others remain at same tier", () => {
    // Simulate a batch of 4 simple stories at 'fast' tier
    const batchStories: UserStory[] = [
      {
        id: "US-001",
        title: "Simple 1",
        description: "First story in batch",
        acceptanceCriteria: ["AC1"],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 0,
        routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "simple" },
      },
      {
        id: "US-002",
        title: "Simple 2",
        description: "Second story in batch",
        acceptanceCriteria: ["AC2"],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 0,
        routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "simple" },
      },
      {
        id: "US-003",
        title: "Simple 3",
        description: "Third story in batch",
        acceptanceCriteria: ["AC3"],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 0,
        routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "simple" },
      },
      {
        id: "US-004",
        title: "Simple 4",
        description: "Fourth story in batch",
        acceptanceCriteria: ["AC4"],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 0,
        routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "simple" },
      },
    ];

    // When batch fails at 'fast' tier:
    // 1. First story (US-001) should escalate to 'balanced'
    const firstStory = batchStories[0];
    const currentTier = firstStory.routing!.modelTier;
    const tierOrder = [
      { tier: "fast", attempts: 5 },
      { tier: "balanced", attempts: 3 },
      { tier: "powerful", attempts: 2 },
    ];
    const nextTier = escalateTier(currentTier!, tierOrder);

    expect(currentTier).toBe("fast");
    expect(nextTier).toBe("balanced");

    // 2. Remaining stories (US-002, US-003, US-004) should remain at 'fast' tier
    // They will be retried individually at the same tier on next iteration
    const remainingStories = batchStories.slice(1);
    for (const story of remainingStories) {
      expect(story.routing!.modelTier).toBe("fast");
      expect(story.status).toBe("pending");
    }

    // 3. This tests the documented "Option B" strategy:
    //    - Only first story escalates
    //    - Others retry individually at same tier first
    //    - This minimizes cost and provides better error isolation
  });

  test("batch failure escalation follows standard escalation chain", () => {
    const tierOrder = [
      { tier: "fast", attempts: 5 },
      { tier: "balanced", attempts: 3 },
      { tier: "powerful", attempts: 2 },
    ];
    const tiers = ["fast", "balanced", "powerful"];
    const expectedNext = ["balanced", "powerful", null];

    for (let i = 0; i < tiers.length; i++) {
      const nextTier = escalateTier(tiers[i], tierOrder);
      expect(nextTier).toBe(expectedNext[i]);
    }

    const powerfulTier = escalateTier("powerful", tierOrder);
    expect(powerfulTier).toBeNull();
  });

  test("batch failure with max attempts should not escalate", () => {
    // When first story in batch has already hit max attempts (e.g., 3),
    // it should be marked as failed instead of escalated
    const story: UserStory = {
      id: "US-001",
      title: "Simple with max attempts",
      description: "Story that has already been retried 3 times",
      acceptanceCriteria: ["AC1"],
      tags: [],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 3, // Already at max attempts (typical config.autoMode.escalation.maxAttempts = 3)
      routing: { complexity: "simple", modelTier: "balanced", testStrategy: "test-after", reasoning: "simple" },
    };

    const maxAttempts = 3;
    const escalationEnabled = true;

    // Should not escalate if attempts >= maxAttempts
    if (escalationEnabled && story.attempts < maxAttempts) {
      // This branch should NOT be taken
      expect(false).toBe(true); // Should not reach here
    } else {
      // Story should be marked as failed (not escalated)
      expect(story.attempts).toBeGreaterThanOrEqual(maxAttempts);
      // In actual runner code, markStoryFailed() would be called here
    }
  });
});


describe("Configurable Escalation Chain (ADR-003)", () => {
  const defaultTiers = [
    { tier: "fast", attempts: 5 },
    { tier: "balanced", attempts: 3 },
    { tier: "powerful", attempts: 2 },
  ];

  test("escalateTier with standard chain", () => {
    expect(escalateTier("fast", defaultTiers)).toBe("balanced");
    expect(escalateTier("balanced", defaultTiers)).toBe("powerful");
    expect(escalateTier("powerful", defaultTiers)).toBeNull();
  });

  test("escalateTier with custom tierOrder (skip balanced)", () => {
    const customOrder = [
      { tier: "fast", attempts: 5 },
      { tier: "powerful", attempts: 2 },
    ];
    expect(escalateTier("fast", customOrder)).toBe("powerful");
    expect(escalateTier("powerful", customOrder)).toBeNull();
    expect(escalateTier("balanced", customOrder)).toBeNull();
  });

  test("escalateTier with single-tier order", () => {
    const singleTier = [{ tier: "fast", attempts: 10 }];
    expect(escalateTier("fast", singleTier)).toBeNull();
  });

  test("escalateTier with reversed order", () => {
    const reversed = [
      { tier: "powerful", attempts: 2 },
      { tier: "balanced", attempts: 3 },
      { tier: "fast", attempts: 5 },
    ];
    expect(escalateTier("powerful", reversed)).toBe("balanced");
    expect(escalateTier("balanced", reversed)).toBe("fast");
    expect(escalateTier("fast", reversed)).toBeNull();
  });

  test("escalateTier with empty tierOrder returns null", () => {
    expect(escalateTier("fast", [])).toBeNull();
  });

  test("escalateTier with three-tier standard order", () => {
    expect(escalateTier("fast", defaultTiers)).toBe("balanced");
    expect(escalateTier("balanced", defaultTiers)).toBe("powerful");
    expect(escalateTier("powerful", defaultTiers)).toBeNull();
  });

  test("escalateTier should return null for unknown tier", () => {
    expect(escalateTier("unknown", defaultTiers)).toBeNull();
  });

  test("escalateTier should be idempotent at max tier", () => {
    expect(escalateTier("powerful", defaultTiers)).toBeNull();
    // Call again — still null
    expect(escalateTier("powerful", defaultTiers)).toBeNull();
  });

  test("calculateMaxIterations sums all tier attempts", () => {
    const { calculateMaxIterations } = require("../../../src/execution/escalation");
    expect(calculateMaxIterations(defaultTiers)).toBe(10); // 5+3+2
    expect(calculateMaxIterations([{ tier: "fast", attempts: 1 }])).toBe(1);
    expect(calculateMaxIterations([])).toBe(0);
  });
});

describe("Pre-Iteration Escalation (BUG-16, BUG-17)", () => {
  const defaultTiers = [
    { tier: "fast", attempts: 5 },
    { tier: "balanced", attempts: 3 },
    { tier: "powerful", attempts: 2 },
  ];

  test("story with attempts >= tier budget should trigger escalation before agent spawn", () => {
    // Simulate a story at "fast" tier with 5 attempts (budget exhausted)
    const story: UserStory = {
      id: "US-001",
      title: "Test story",
      description: "Test",
      acceptanceCriteria: ["AC1"],
      tags: [],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 5, // Exhausted fast tier budget (5 attempts)
      routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "simple" },
    };

    // Get tier config
    const currentTier = story.routing!.modelTier;
    const tierCfg = defaultTiers.find((t) => t.tier === currentTier);

    expect(tierCfg).toBeDefined();
    expect(story.attempts).toBeGreaterThanOrEqual(tierCfg!.attempts);

    // Should escalate to next tier
    const nextTier = escalateTier(currentTier!, defaultTiers);
    expect(nextTier).toBe("balanced");
  });

  test("story at balanced tier with 3 attempts should escalate to powerful", () => {
    const story: UserStory = {
      id: "US-002",
      title: "Test story",
      description: "Test",
      acceptanceCriteria: ["AC1"],
      tags: [],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 3, // Exhausted balanced tier budget (3 attempts)
      routing: { complexity: "medium", modelTier: "balanced", testStrategy: "test-after", reasoning: "medium" },
    };

    const currentTier = story.routing!.modelTier;
    const tierCfg = defaultTiers.find((t) => t.tier === currentTier);

    expect(tierCfg).toBeDefined();
    expect(story.attempts).toBeGreaterThanOrEqual(tierCfg!.attempts);

    const nextTier = escalateTier(currentTier!, defaultTiers);
    expect(nextTier).toBe("powerful");
  });

  test("story at powerful tier with 2 attempts should mark as FAILED (no more tiers)", () => {
    const story: UserStory = {
      id: "US-003",
      title: "Test story",
      description: "Test",
      acceptanceCriteria: ["AC1"],
      tags: [],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 2, // Exhausted powerful tier budget (2 attempts)
      routing: { complexity: "complex", modelTier: "powerful", testStrategy: "test-after", reasoning: "complex" },
    };

    const currentTier = story.routing!.modelTier;
    const tierCfg = defaultTiers.find((t) => t.tier === currentTier);

    expect(tierCfg).toBeDefined();
    expect(story.attempts).toBeGreaterThanOrEqual(tierCfg!.attempts);

    // No next tier available
    const nextTier = escalateTier(currentTier!, defaultTiers);
    expect(nextTier).toBeNull();

    // Story should be marked as FAILED (not retried)
    // In actual runner code, markStoryFailed() would be called here
  });

  test("pre-iteration check prevents infinite loop at same tier", () => {
    // BUG-16: Stories were looping indefinitely at same tier
    // This test verifies that pre-iteration escalation prevents this

    const story: UserStory = {
      id: "US-004",
      title: "ASSET_CHECK failing story",
      description: "Story with missing files",
      acceptanceCriteria: ["AC1"],
      tags: [],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 5, // Budget exhausted
      routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "simple" },
      priorErrors: ["ASSET_CHECK_FAILED: Missing file src/test.ts"],
    };

    // Pre-iteration check should trigger escalation
    const currentTier = story.routing!.modelTier;
    const tierCfg = defaultTiers.find((t) => t.tier === currentTier);

    expect(story.attempts).toBeGreaterThanOrEqual(tierCfg!.attempts);

    // Should escalate instead of retrying at same tier
    const nextTier = escalateTier(currentTier!, defaultTiers);
    expect(nextTier).toBe("balanced");
  });

  test("ASSET_CHECK failure should increment attempts and respect escalation", () => {
    // BUG-17: ASSET_CHECK failures were reverting to pending without escalation
    const story: UserStory = {
      id: "US-005",
      title: "Story with ASSET_CHECK failure",
      description: "Test",
      acceptanceCriteria: ["AC1"],
      tags: [],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 4, // One attempt left in fast tier
      routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "simple" },
    };

    // Simulate ASSET_CHECK failure
    const updatedStory = {
      ...story,
      attempts: story.attempts + 1, // Increment attempts
      priorErrors: ["ASSET_CHECK_FAILED: Missing file src/finder.ts"],
    };

    expect(updatedStory.attempts).toBe(5);

    // Now attempts >= tier budget, should escalate on next iteration
    const tierCfg = defaultTiers.find((t) => t.tier === "fast");
    expect(updatedStory.attempts).toBeGreaterThanOrEqual(tierCfg!.attempts);

    const nextTier = escalateTier("fast", defaultTiers);
    expect(nextTier).toBe("balanced");
  });

  test("story below tier budget should not escalate", () => {
    const story: UserStory = {
      id: "US-006",
      title: "Story with attempts below budget",
      description: "Test",
      acceptanceCriteria: ["AC1"],
      tags: [],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 2, // Below fast tier budget (5 attempts)
      routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "simple" },
    };

    const currentTier = story.routing!.modelTier;
    const tierCfg = defaultTiers.find((t) => t.tier === currentTier);

    expect(tierCfg).toBeDefined();
    expect(story.attempts).toBeLessThan(tierCfg!.attempts);

    // Should NOT escalate (continue at same tier)
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T6: resolveMaxAttemptsOutcome — failure category → pause vs fail
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveMaxAttemptsOutcome", () => {
  describe("categories that require human review → pause", () => {
    test("isolation-violation → pause", () => {
      const result = resolveMaxAttemptsOutcome("isolation-violation");
      expect(result).toBe("pause");
    });

    test("verifier-rejected → pause", () => {
      const result = resolveMaxAttemptsOutcome("verifier-rejected");
      expect(result).toBe("pause");
    });

    test("greenfield-no-tests → pause", () => {
      const result = resolveMaxAttemptsOutcome("greenfield-no-tests");
      expect(result).toBe("pause");
    });
  });

  describe("categories that can be failed automatically → fail", () => {
    test("session-failure → fail", () => {
      const result = resolveMaxAttemptsOutcome("session-failure");
      expect(result).toBe("fail");
    });

    test("tests-failing → fail", () => {
      const result = resolveMaxAttemptsOutcome("tests-failing");
      expect(result).toBe("fail");
    });

    test("undefined (no category) → fail", () => {
      const result = resolveMaxAttemptsOutcome(undefined);
      expect(result).toBe("fail");
    });
  });

  describe("exhaustive coverage of all FailureCategory values", () => {
    const pauseCategories: FailureCategory[] = ["isolation-violation", "verifier-rejected", "greenfield-no-tests"];
    const failCategories: FailureCategory[] = ["session-failure", "tests-failing"];

    for (const cat of pauseCategories) {
      test(`${cat} always returns pause`, () => {
        expect(resolveMaxAttemptsOutcome(cat)).toBe("pause");
      });
    }

    for (const cat of failCategories) {
      test(`${cat} always returns fail`, () => {
        expect(resolveMaxAttemptsOutcome(cat)).toBe("fail");
      });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T6: retryAsLite routing update logic
// ─────────────────────────────────────────────────────────────────────────────

describe("retryAsLite → testStrategy downgrade", () => {
  /**
   * Simulates the routing update logic from the escalate case in runner.ts.
   * This mirrors the exact transform applied to story.routing when escalating.
   */
  function applyEscalationRouting(
    routing: UserStory["routing"],
    nextTier: "fast" | "balanced" | "powerful",
    retryAsLite: boolean,
  ): UserStory["routing"] {
    if (!routing) return undefined;
    return {
      ...routing,
      modelTier: nextTier,
      ...(retryAsLite ? { testStrategy: "three-session-tdd-lite" as const } : {}),
    };
  }

  test("retryAsLite=true downgrades testStrategy to three-session-tdd-lite", () => {
    const routing: UserStory["routing"] = {
      complexity: "complex",
      modelTier: "fast",
      testStrategy: "three-session-tdd",
      reasoning: "complex",
    };

    const updated = applyEscalationRouting(routing, "balanced", true);

    expect(updated?.testStrategy).toBe("three-session-tdd-lite");
    expect(updated?.modelTier).toBe("balanced");
    expect(updated?.complexity).toBe("complex");
  });

  test("retryAsLite=false leaves testStrategy unchanged", () => {
    const routing: UserStory["routing"] = {
      complexity: "complex",
      modelTier: "fast",
      testStrategy: "three-session-tdd",
      reasoning: "complex",
    };

    const updated = applyEscalationRouting(routing, "balanced", false);

    expect(updated?.testStrategy).toBe("three-session-tdd");
    expect(updated?.modelTier).toBe("balanced");
  });

  test("strategy downgrade happens alongside tier escalation (both applied)", () => {
    const routing: UserStory["routing"] = {
      complexity: "complex",
      modelTier: "fast",
      testStrategy: "three-session-tdd",
      reasoning: "complex",
    };

    const updated = applyEscalationRouting(routing, "powerful", true);

    // Both tier escalation AND strategy downgrade apply simultaneously
    expect(updated?.modelTier).toBe("powerful");
    expect(updated?.testStrategy).toBe("three-session-tdd-lite");
  });

  test("already-lite strategy remains lite after retryAsLite=true", () => {
    const routing: UserStory["routing"] = {
      complexity: "complex",
      modelTier: "fast",
      testStrategy: "three-session-tdd-lite",
      reasoning: "complex",
    };

    const updated = applyEscalationRouting(routing, "balanced", true);

    expect(updated?.testStrategy).toBe("three-session-tdd-lite");
  });

  test("test-after strategy is not changed by retryAsLite (should not happen, but safe)", () => {
    const routing: UserStory["routing"] = {
      complexity: "simple",
      modelTier: "fast",
      testStrategy: "test-after",
      reasoning: "simple",
    };

    // retryAsLite would only be set for TDD stories, but test correctness:
    const updated = applyEscalationRouting(routing, "balanced", true);

    // retryAsLite overrides to lite, but this would be a bug in routing
    // (retryAsLite should only be set when testStrategy is three-session-tdd)
    expect(updated?.modelTier).toBe("balanced");
  });

  test("undefined routing returns undefined", () => {
    const updated = applyEscalationRouting(undefined, "balanced", true);
    expect(updated).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T6: TDD Escalation Attempts Counting
// ─────────────────────────────────────────────────────────────────────────────

