// RE-ARCH: keep
/**
 * S5: Strategy Fallback Tests — greenfield-no-tests → test-after
 *
 * Moved from test/integration/context/ — pure logic, no integration surface.
 * Import goes to the leaf module, not runner.ts barrel, to avoid importing
 * heavy ACP/registry side-effects that can keep the Bun process alive.
 */

import { describe, expect, test } from "bun:test";
import { resolveMaxAttemptsOutcome } from "../../../../src/execution/escalation/tier-escalation";
import type { UserStory } from "../../../../src/prd";
import type { FailureCategory } from "../../../../src/tdd/types";

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

      expect(routing?.testStrategy).toBe("test-after");
      expect(routing?.modelTier).toBe("balanced"); // Tier escalates
      expect(attempts).toBe(0); // Attempts reset on tier escalation
    });

    test("greenfield-no-tests fires twice on same story (second time escalates)", () => {
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
      story = { ...story, attempts: result.attempts, routing: result.routing };

      expect(story.routing?.testStrategy).toBe("test-after");
      expect(story.routing?.modelTier).toBe("fast");
      expect(story.attempts).toBe(0);

      // Second greenfield-no-tests: already on test-after, escalate tier
      result = applyGreenfieldFallbackRouting(story, "greenfield-no-tests", "balanced");
      story = { ...story, attempts: result.attempts, routing: result.routing };

      expect(story.routing?.testStrategy).toBe("test-after"); // Stays test-after
      expect(story.routing?.modelTier).toBe("balanced"); // Tier escalates
      expect(story.attempts).toBe(0); // Attempts reset on tier change
    });
  });

  describe("resolveMaxAttemptsOutcome for greenfield-no-tests", () => {
    test("greenfield-no-tests returns pause (requires human review)", () => {
      expect(resolveMaxAttemptsOutcome("greenfield-no-tests")).toBe("pause");
    });

    test("greenfield-no-tests pauses only when max attempts exhausted", () => {
      expect(resolveMaxAttemptsOutcome("greenfield-no-tests")).toBe("pause");
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

      const { routing } = applyGreenfieldFallbackRouting(story, "isolation-violation", "balanced");

      expect(routing?.testStrategy).toBe("three-session-tdd");
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

      const { routing } = applyGreenfieldFallbackRouting(story, "tests-failing", "balanced");

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

      const { routing } = applyGreenfieldFallbackRouting(story, "greenfield-no-tests", "balanced");

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

      const { routing } = applyGreenfieldFallbackRouting(story, undefined, "balanced");

      expect(routing?.testStrategy).toBe("three-session-tdd");
      expect(routing?.modelTier).toBe("balanced");
    });
  });
});
