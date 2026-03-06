// RE-ARCH: keep
/**
 * S5: Strategy Fallback Tests
 *
 * Tests for greenfield-no-tests → test-after strategy switch.
 *
 * When a story fails with greenfield-no-tests failure category,
 * it should switch to test-after strategy (once) instead of escalating tier.
 */

import { describe, expect, test } from "bun:test";
import { resolveMaxAttemptsOutcome } from "../../../src/execution/runner";
import type { UserStory } from "../../../src/prd";
import type { FailureCategory } from "../../../src/tdd/types";

describe("S5: greenfield-no-tests fallback", () => {
  /**
   * Simulates the escalation routing logic from runner.ts for test-after switch.
   * This mirrors the exact transform applied when greenfield-no-tests fires.
   */
  function applyGreenfieldFallbackRouting(
    story: UserStory,
    escalateFailureCategory: FailureCategory | undefined,
    nextTier: "fast" | "balanced" | "powerful",
  ): { routing: UserStory["routing"]; attempts: number } {
    const escalateRetryAsTestAfter = escalateFailureCategory === "greenfield-no-tests";
    const currentTestStrategy = story.routing?.testStrategy ?? "test-after";
    const shouldSwitchToTestAfter = escalateRetryAsTestAfter && currentTestStrategy !== "test-after";

    const updatedRouting = story.routing
      ? {
          ...story.routing,
          modelTier: shouldSwitchToTestAfter ? story.routing.modelTier : nextTier,
          ...(shouldSwitchToTestAfter ? { testStrategy: "test-after" as const } : {}),
        }
      : undefined;

    const shouldResetAttempts = shouldSwitchToTestAfter || story.routing?.modelTier !== nextTier;

    return {
      routing: updatedRouting,
      attempts: shouldResetAttempts ? 0 : (story.attempts ?? 0) + 1,
    };
  }

  describe("AC1: greenfield-no-tests switches to test-after on first occurrence", () => {
    test("story on three-session-tdd switches to test-after and resets attempts", () => {
      const story: UserStory = {
        id: "US-001",
        title: "Greenfield Story",
        description: "Story with no existing tests",
        acceptanceCriteria: ["AC1"],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 2,
        routing: {
          complexity: "complex",
          modelTier: "fast",
          testStrategy: "three-session-tdd",
          reasoning: "complex",
        },
      };

      const { routing, attempts } = applyGreenfieldFallbackRouting(story, "greenfield-no-tests", "balanced");

      // Should switch to test-after WITHOUT escalating tier
      expect(routing?.testStrategy).toBe("test-after");
      expect(routing?.modelTier).toBe("fast"); // Tier stays the same
      expect(attempts).toBe(0); // Attempts reset on strategy switch
    });

    test("story on three-session-tdd-lite switches to test-after", () => {
      const story: UserStory = {
        id: "US-002",
        title: "Lite TDD Story",
        description: "Story using lite mode",
        acceptanceCriteria: ["AC1"],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 3,
        routing: {
          complexity: "complex",
          modelTier: "balanced",
          testStrategy: "three-session-tdd-lite",
          reasoning: "complex",
        },
      };

      const { routing, attempts } = applyGreenfieldFallbackRouting(story, "greenfield-no-tests", "powerful");

      expect(routing?.testStrategy).toBe("test-after");
      expect(routing?.modelTier).toBe("balanced"); // Tier stays the same
      expect(attempts).toBe(0); // Attempts reset
    });
  });

  describe("AC2: greenfield-no-tests on test-after proceeds with normal escalation", () => {
    test("story already on test-after escalates tier normally", () => {
      const story: UserStory = {
        id: "US-003",
        title: "Test-after Story",
        description: "Story already using test-after",
        acceptanceCriteria: ["AC1"],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 4,
        routing: {
          complexity: "simple",
          modelTier: "fast",
          testStrategy: "test-after",
          reasoning: "simple",
        },
      };

      const { routing, attempts } = applyGreenfieldFallbackRouting(story, "greenfield-no-tests", "balanced");

      // Should NOT switch strategy (already test-after)
      expect(routing?.testStrategy).toBe("test-after");
      // Should escalate tier normally
      expect(routing?.modelTier).toBe("balanced");
      // Attempts reset on tier escalation
      expect(attempts).toBe(0);
    });

    test("greenfield-no-tests fires twice on same story (second time escalates)", () => {
      // First occurrence: three-session-tdd → test-after
      let story: UserStory = {
        id: "US-004",
        title: "Double Greenfield",
        description: "Story that triggers greenfield twice",
        acceptanceCriteria: ["AC1"],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 2,
        routing: {
          complexity: "complex",
          modelTier: "fast",
          testStrategy: "three-session-tdd",
          reasoning: "complex",
        },
      };

      // First greenfield-no-tests: switch to test-after
      let result = applyGreenfieldFallbackRouting(story, "greenfield-no-tests", "balanced");
      story = {
        ...story,
        attempts: result.attempts,
        routing: result.routing,
      };

      expect(story.routing?.testStrategy).toBe("test-after");
      expect(story.routing?.modelTier).toBe("fast");
      expect(story.attempts).toBe(0);

      // Second greenfield-no-tests: already on test-after, escalate tier
      result = applyGreenfieldFallbackRouting(story, "greenfield-no-tests", "balanced");
      story = {
        ...story,
        attempts: result.attempts,
        routing: result.routing,
      };

      expect(story.routing?.testStrategy).toBe("test-after"); // Stays test-after
      expect(story.routing?.modelTier).toBe("balanced"); // Tier escalates
      expect(story.attempts).toBe(0); // Attempts reset on tier change
    });
  });

  describe("resolveMaxAttemptsOutcome for greenfield-no-tests", () => {
    test("greenfield-no-tests returns pause (requires human review)", () => {
      const result = resolveMaxAttemptsOutcome("greenfield-no-tests");
      expect(result).toBe("pause");
    });

    test("greenfield-no-tests pauses only when max attempts exhausted", () => {
      // This test documents that pause only happens AFTER the one-time switch
      // When canEscalate=false (max attempts reached), resolveMaxAttemptsOutcome fires
      const result = resolveMaxAttemptsOutcome("greenfield-no-tests");
      expect(result).toBe("pause");
    });
  });

  describe("non-greenfield-no-tests categories behave normally", () => {
    test("isolation-violation does NOT trigger test-after switch", () => {
      const story: UserStory = {
        id: "US-005",
        title: "Isolation Violation",
        description: "Story with isolation issue",
        acceptanceCriteria: ["AC1"],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 2,
        routing: {
          complexity: "complex",
          modelTier: "fast",
          testStrategy: "three-session-tdd",
          reasoning: "complex",
        },
      };

      const { routing, attempts } = applyGreenfieldFallbackRouting(story, "isolation-violation", "balanced");

      // Should NOT switch to test-after (different failure category)
      expect(routing?.testStrategy).toBe("three-session-tdd");
      // Should escalate tier normally
      expect(routing?.modelTier).toBe("balanced");
    });

    test("tests-failing does NOT trigger test-after switch", () => {
      const story: UserStory = {
        id: "US-006",
        title: "Tests Failing",
        description: "Story with failing tests",
        acceptanceCriteria: ["AC1"],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 3,
        routing: {
          complexity: "complex",
          modelTier: "fast",
          testStrategy: "three-session-tdd",
          reasoning: "complex",
        },
      };

      const { routing, attempts } = applyGreenfieldFallbackRouting(story, "tests-failing", "balanced");

      expect(routing?.testStrategy).toBe("three-session-tdd");
      expect(routing?.modelTier).toBe("balanced");
    });
  });

  describe("edge cases", () => {
    test("story without routing field handles switch gracefully", () => {
      const story: UserStory = {
        id: "US-007",
        title: "No Routing",
        description: "Story without routing",
        acceptanceCriteria: ["AC1"],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 1,
        routing: undefined,
      };

      const { routing, attempts } = applyGreenfieldFallbackRouting(story, "greenfield-no-tests", "balanced");

      expect(routing).toBeUndefined();
    });

    test("undefined failure category does NOT trigger test-after switch", () => {
      const story: UserStory = {
        id: "US-008",
        title: "No Category",
        description: "Story with no failure category",
        acceptanceCriteria: ["AC1"],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 2,
        routing: {
          complexity: "complex",
          modelTier: "fast",
          testStrategy: "three-session-tdd",
          reasoning: "complex",
        },
      };

      const { routing, attempts } = applyGreenfieldFallbackRouting(story, undefined, "balanced");

      expect(routing?.testStrategy).toBe("three-session-tdd");
      expect(routing?.modelTier).toBe("balanced");
    });
  });
});
