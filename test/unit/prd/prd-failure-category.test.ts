// RE-ARCH: keep
/**
 * PRD failureCategory Tests
 *
 * Tests for failureCategory field on UserStory and the markStoryFailed()
 * function storing the category.
 */

import { describe, expect, test } from "bun:test";
import type { FailureCategory } from "@/execution";
import { markStoryFailed, markStoryPassed, markStoryPaused } from "@/prd";
import type { PRD, UserStory } from "@/prd/types";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeStory(id: string): UserStory {
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

// ── UserStory interface ───────────────────────────────────────────────────────

describe("UserStory.failureCategory field", () => {
  test("is optional — not present by default", () => {
    const story = makeStory("US-001");
    expect(story.failureCategory).toBeUndefined();
  });

  test("can be assigned a FailureCategory value", () => {
    const story = makeStory("US-001");
    story.failureCategory = "session-failure";
    expect(story.failureCategory).toBe("session-failure");
  });

  test("accepts all four FailureCategory values", () => {
    const categories: FailureCategory[] = [
      "isolation-violation",
      "session-failure",
      "tests-failing",
      "verifier-rejected",
    ];
    const story = makeStory("US-001");
    for (const cat of categories) {
      story.failureCategory = cat;
      expect(story.failureCategory).toBe(cat);
    }
  });
});

// ── markStoryFailed() ─────────────────────────────────────────────────────────

describe("markStoryFailed()", () => {
  test("marks story as failed (backward compat — no failureCategory)", () => {
    const prd = makePrd([makeStory("US-001")]);
    markStoryFailed(prd, "US-001");
    expect(prd.userStories[0].status).toBe("failed");
    expect(prd.userStories[0].failureCategory).toBeUndefined();
  });

  test("increments attempts when no failureCategory given", () => {
    const prd = makePrd([makeStory("US-001")]);
    markStoryFailed(prd, "US-001");
    expect(prd.userStories[0].attempts).toBe(1);
  });

  test("stores failureCategory='session-failure'", () => {
    const prd = makePrd([makeStory("US-001")]);
    markStoryFailed(prd, "US-001", "session-failure");
    expect(prd.userStories[0].failureCategory).toBe("session-failure");
    expect(prd.userStories[0].status).toBe("failed");
  });

  test.each([
    ["isolation-violation" as const],
    ["tests-failing" as const],
    ["verifier-rejected" as const],
  ])("stores failureCategory='%s'", (category) => {
    const prd = makePrd([makeStory("US-001")]);
    markStoryFailed(prd, "US-001", category);
    expect(prd.userStories[0].failureCategory).toBe(category);
  });

  test("increments attempts when failureCategory is given", () => {
    const prd = makePrd([makeStory("US-001")]);
    prd.userStories[0].attempts = 2;
    markStoryFailed(prd, "US-001", "tests-failing");
    expect(prd.userStories[0].attempts).toBe(3);
  });

  test("does not overwrite failureCategory with undefined when not passed", () => {
    const prd = makePrd([makeStory("US-001")]);
    // Simulate a prior failure that set a category
    prd.userStories[0].failureCategory = "session-failure";
    // Call without a category — should NOT clear the existing value
    markStoryFailed(prd, "US-001");
    expect(prd.userStories[0].failureCategory).toBe("session-failure");
  });

  test("does nothing when story not found", () => {
    const prd = makePrd([makeStory("US-001")]);
    // Should not throw
    markStoryFailed(prd, "US-999", "session-failure");
    expect(prd.userStories[0].status).toBe("pending");
  });

  // `passes` is a separate field from `status`, and dependency resolution reads
  // `passes` (story-selector.ts / story-context.ts) rather than `status`. A
  // story can genuinely go passed -> failed: unified-executor.ts marks a story
  // failed on merge conflict after its pipeline passed. If `passes` is left
  // true, dependents treat the failure as satisfied and run anyway.
  test("clears passes when a previously-passed story fails", () => {
    const prd = makePrd([makeStory("US-001")]);
    markStoryPassed(prd, "US-001");
    expect(prd.userStories[0].passes).toBe(true);

    markStoryFailed(prd, "US-001", "tests-failing");

    expect(prd.userStories[0].status).toBe("failed");
    expect(prd.userStories[0].passes).toBe(false);
  });

  test("does not affect other stories", () => {
    const prd = makePrd([makeStory("US-001"), makeStory("US-002")]);
    markStoryFailed(prd, "US-001", "tests-failing");
    expect(prd.userStories[1].status).toBe("pending");
    expect(prd.userStories[1].failureCategory).toBeUndefined();
  });
});

// ── FailureCategory type export from src/execution ───────────────────────────

describe("FailureCategory export from src/execution", () => {
  test("FailureCategory is exported from src/execution index", () => {
    // This test verifies the re-export compiles and can be used as a type
    const cat: FailureCategory = "session-failure";
    expect(cat).toBe("session-failure");
  });

  test("all failure categories are valid FailureCategory values", () => {
    const isolation: FailureCategory = "isolation-violation";
    const session: FailureCategory = "session-failure";
    const failing: FailureCategory = "tests-failing";
    const incorrectTest: FailureCategory = "test-incorrect";
    const gateExhausted: FailureCategory = "full-suite-gate-exhausted";
    const rejected: FailureCategory = "verifier-rejected";
    expect([isolation, session, failing, incorrectTest, gateExhausted, rejected]).toHaveLength(6);
  });
});

// ── markStoryPaused / markStoryPassed unaffected ─────────────────────────────

describe("markStoryPaused and markStoryPassed — failureCategory not affected", () => {
  test.each([
    ["Paused" as const, (prd: PRD) => markStoryPaused(prd, "US-001"), "paused" as const],
    ["Passed" as const, (prd: PRD) => markStoryPassed(prd, "US-001"), "passed" as const],
  ])("markStory%s does not set failureCategory", (_label, fn, expectedStatus) => {
    const prd = makePrd([makeStory("US-001")]);
    fn(prd);
    expect(prd.userStories[0].status).toBe(expectedStatus);
    expect(prd.userStories[0].failureCategory).toBeUndefined();
  });
});

// ── nax#1582: markStoryPaused persists the blocking reason ───────────────────

describe("markStoryPaused — reason persistence (nax#1582)", () => {
  test("appends a PAUSED: entry to priorErrors when reason is given", () => {
    const prd = makePrd([makeStory("US-001")]);
    markStoryPaused(prd, "US-001", "Semantic review failed: 1 findings");
    expect(prd.userStories[0].priorErrors).toEqual(["PAUSED: Semantic review failed: 1 findings"]);
  });

  test("leaves priorErrors untouched when no reason is given", () => {
    const prd = makePrd([makeStory("US-001")]);
    markStoryPaused(prd, "US-001");
    expect(prd.userStories[0].priorErrors ?? []).toHaveLength(0);
  });

  test("appends to existing priorErrors rather than replacing them", () => {
    const prd = makePrd([makeStory("US-001")]);
    prd.userStories[0].priorErrors = ["Attempt 1 failed with model tier: fast"];
    markStoryPaused(prd, "US-001", "Rectification exhausted");
    expect(prd.userStories[0].priorErrors).toEqual([
      "Attempt 1 failed with model tier: fast",
      "PAUSED: Rectification exhausted",
    ]);
  });
});
