// RE-ARCH: keep
/**
 * getNextStory() Unit Tests (BUG-022)
 *
 * Tests for the story retry priority behavior:
 * - Retries current failed story when attempts <= maxRetries
 * - Moves to next pending story when retries exhausted
 * - Preserves backward-compatible behavior when called without params
 */

import { describe, expect, test } from "bun:test";
import { getNextStory, markStoryFailed } from "../../../src/prd";
import type { PRD, UserStory } from "../../../src/prd/types";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeStory(id: string, overrides: Partial<UserStory> = {}): UserStory {
  return {
    id,
    title: `Story ${id}`,
    description: "Test story",
    acceptanceCriteria: ["AC1"],
    tags: [],
    dependencies: [],
    status: "pending",
    passes: false,
    escalations: [],
    attempts: 0,
    ...overrides,
  };
}

function makePrd(stories: UserStory[]): PRD {
  return {
    project: "test",
    feature: "test-feature",
    branchName: "feature/test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: stories,
  };
}

// ── Backward-compatible behavior (no params) ─────────────────────────────────

describe("getNextStory() — backward compat (no currentStoryId/maxRetries)", () => {
  test("returns first pending story", () => {
    const prd = makePrd([makeStory("US-001"), makeStory("US-002")]);
    expect(getNextStory(prd)?.id).toBe("US-001");
  });

  test("skips failed stories (existing behavior)", () => {
    const prd = makePrd([makeStory("US-001"), makeStory("US-002")]);
    markStoryFailed(prd, "US-001");

    expect(getNextStory(prd)?.id).toBe("US-002");
  });

  test("returns null when all stories are failed or passed", () => {
    const prd = makePrd([makeStory("US-001"), makeStory("US-002")]);
    markStoryFailed(prd, "US-001");
    prd.userStories[1].status = "passed";
    prd.userStories[1].passes = true;

    expect(getNextStory(prd)).toBeNull();
  });
});

// ── Retry priority (BUG-022) ─────────────────────────────────────────────────

// BUG-022
describe("getNextStory() — retry priority: failed story retried before advancing to next", () => {
  test("returns failed current story when attempts <= maxRetries", () => {
    const prd = makePrd([makeStory("US-001"), makeStory("US-002")]);
    markStoryFailed(prd, "US-001"); // attempts = 1

    // With maxRetries=2 and attempts=1, S1 should be retried
    const next = getNextStory(prd, "US-001", 2);
    expect(next?.id).toBe("US-001");
  });

  test("returns failed current story on last allowed retry (attempts == maxRetries)", () => {
    const prd = makePrd([makeStory("US-001"), makeStory("US-002")]);
    markStoryFailed(prd, "US-001"); // attempts = 1
    markStoryFailed(prd, "US-001"); // attempts = 2

    // With maxRetries=2 and attempts=2, still within limit
    const next = getNextStory(prd, "US-001", 2);
    expect(next?.id).toBe("US-001");
  });

  test("moves to next story when attempts exceed maxRetries", () => {
    const prd = makePrd([makeStory("US-001"), makeStory("US-002")]);
    markStoryFailed(prd, "US-001"); // attempts = 1
    markStoryFailed(prd, "US-001"); // attempts = 2
    markStoryFailed(prd, "US-001"); // attempts = 3

    // With maxRetries=2 and attempts=3, move to US-002
    const next = getNextStory(prd, "US-001", 2);
    expect(next?.id).toBe("US-002");
  });

  test("moves to next story when current story is not failed", () => {
    const prd = makePrd([makeStory("US-001"), makeStory("US-002")]);
    // US-001 is pending (not failed)

    const next = getNextStory(prd, "US-001", 2);
    expect(next?.id).toBe("US-001"); // Normal pending story picked up
  });

  test("skips retry when maxRetries=0", () => {
    const prd = makePrd([makeStory("US-001"), makeStory("US-002")]);
    markStoryFailed(prd, "US-001"); // attempts = 1

    // maxRetries=0 disables retry — move to US-002
    const next = getNextStory(prd, "US-001", 0);
    expect(next?.id).toBe("US-002");
  });

  test("skips retry when currentStoryId is null", () => {
    const prd = makePrd([makeStory("US-001"), makeStory("US-002")]);
    markStoryFailed(prd, "US-001"); // attempts = 1

    // null currentStoryId — no retry priority, picks next pending
    const next = getNextStory(prd, null, 2);
    expect(next?.id).toBe("US-002");
  });

  test("skips retry when currentStoryId not found in PRD", () => {
    const prd = makePrd([makeStory("US-001"), makeStory("US-002")]);
    markStoryFailed(prd, "US-001");

    // Unknown story ID — falls through to normal logic
    const next = getNextStory(prd, "US-999", 2);
    expect(next?.id).toBe("US-002");
  });
});

// ── Run order (AC-2) ─────────────────────────────────────────────────────────

describe("getNextStory() — run order S1-I1 -> S1-I2 (retry) -> S2-I1", () => {
  test("enforces retry-before-next-story order across simulated iterations", () => {
    const prd = makePrd([makeStory("US-001"), makeStory("US-002")]);
    let lastId: string | null = null;
    const maxRetries = 1;
    const order: string[] = [];

    // Iteration 1: S1 first attempt
    const pick1 = getNextStory(prd, lastId, maxRetries);
    expect(pick1?.id).toBe("US-001");
    order.push(pick1!.id);
    lastId = pick1!.id;
    markStoryFailed(prd, "US-001"); // S1 fails (attempts = 1)

    // Iteration 2: S1 retry (attempts=1 <= maxRetries=1)
    const pick2 = getNextStory(prd, lastId, maxRetries);
    expect(pick2?.id).toBe("US-001");
    order.push(pick2!.id);
    lastId = pick2!.id;
    markStoryFailed(prd, "US-001"); // S1 fails again (attempts = 2)

    // Iteration 3: S1 exhausted (attempts=2 > maxRetries=1), move to S2
    const pick3 = getNextStory(prd, lastId, maxRetries);
    expect(pick3?.id).toBe("US-002");
    order.push(pick3!.id);

    expect(order).toEqual(["US-001", "US-001", "US-002"]);
  });

  test("moves to S2 after S1 passes (no retry needed)", () => {
    const prd = makePrd([makeStory("US-001"), makeStory("US-002")]);
    let lastId: string | null = null;
    const maxRetries = 2;

    // Iteration 1: S1 picked
    const pick1 = getNextStory(prd, lastId, maxRetries);
    expect(pick1?.id).toBe("US-001");
    lastId = pick1!.id;

    // S1 passes
    prd.userStories[0].status = "passed";
    prd.userStories[0].passes = true;

    // Iteration 2: S2 picked (S1 done)
    const pick2 = getNextStory(prd, lastId, maxRetries);
    expect(pick2?.id).toBe("US-002");
  });

  test("BUG-029: prioritizes escalated story (pending + attempts > 0) over other pending stories", () => {
    const prd = makePrd([makeStory("US-001"), makeStory("US-002"), makeStory("US-003")]);
    const maxRetries = 2;

    // Simulate: US-001 was escalated — status reset to "pending" but has prior attempts
    prd.userStories[0].status = "pending";
    prd.userStories[0].attempts = 1;
    prd.userStories[0].routing = { complexity: "simple", modelTier: "balanced", testStrategy: "test-after" };

    // getNextStory should prioritize US-001 (escalated, pending with attempts)
    const pick = getNextStory(prd, "US-001", maxRetries);
    expect(pick?.id).toBe("US-001");
  });

  test("BUG-029: does not reprioritize story with 0 attempts (fresh pending)", () => {
    const prd = makePrd([makeStory("US-001"), makeStory("US-002")]);
    const maxRetries = 2;

    // US-001 is fresh pending (no prior attempts) — normal ordering applies
    prd.userStories[0].status = "pending";
    prd.userStories[0].attempts = 0;

    // Should still pick US-001 (first pending), but via normal path not escalation path
    const pick = getNextStory(prd, "US-002", maxRetries);
    expect(pick?.id).toBe("US-001");
  });
});

// ── External dependencies (prior-phase) ─────────────────────────────────────

describe("getNextStory() — external dependencies treated as fulfilled", () => {
  test("returns story whose only dependency is external (not in PRD)", () => {
    // VCS-P2-001 is from a prior feature run and is absent from this PRD
    const prd = makePrd([makeStory("VCS-P3-001-A", { dependencies: ["VCS-P2-001"] })]);
    expect(getNextStory(prd)?.id).toBe("VCS-P3-001-A");
  });

  test("returns story with mix of external + satisfied internal dependency", () => {
    const prd = makePrd([
      makeStory("US-001", { status: "passed", passes: true }),
      makeStory("US-002", { dependencies: ["EXT-PHASE1", "US-001"] }),
    ]);
    expect(getNextStory(prd)?.id).toBe("US-002");
  });

  test("does not return story when internal dependency is unsatisfied even if external is absent", () => {
    const prd = makePrd([
      makeStory("US-001"), // pending, not done
      makeStory("US-002", { dependencies: ["EXT-PHASE1", "US-001"] }),
    ]);
    // US-001 should be picked (it has no unmet deps), not US-002
    expect(getNextStory(prd)?.id).toBe("US-001");
  });

  test("skips decomposed stories that have only external deps", () => {
    const prd = makePrd([
      makeStory("VCS-P3-001", { status: "decomposed", dependencies: ["VCS-P2-001"] }),
      makeStory("VCS-P3-001-A", { dependencies: ["VCS-P2-001"] }),
    ]);
    // VCS-P3-001 is decomposed → skipped; VCS-P3-001-A is pending and ready
    expect(getNextStory(prd)?.id).toBe("VCS-P3-001-A");
  });
});
