/**
 * PRD failureCategory Tests
 *
 * Tests for failureCategory field on UserStory and the markStoryFailed()
 * function storing the category.
 */

import { describe, expect, test } from "bun:test";
import type { PRD, UserStory } from "../src/prd/types";
import { markStoryFailed, markStoryPaused, markStoryPassed } from "../src/prd";
import type { FailureCategory } from "../src/execution";

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

  test("stores failureCategory='isolation-violation'", () => {
    const prd = makePrd([makeStory("US-001")]);
    markStoryFailed(prd, "US-001", "isolation-violation");
    expect(prd.userStories[0].failureCategory).toBe("isolation-violation");
  });

  test("stores failureCategory='tests-failing'", () => {
    const prd = makePrd([makeStory("US-001")]);
    markStoryFailed(prd, "US-001", "tests-failing");
    expect(prd.userStories[0].failureCategory).toBe("tests-failing");
  });

  test("stores failureCategory='verifier-rejected'", () => {
    const prd = makePrd([makeStory("US-001")]);
    markStoryFailed(prd, "US-001", "verifier-rejected");
    expect(prd.userStories[0].failureCategory).toBe("verifier-rejected");
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

  test("all four categories are valid FailureCategory values", () => {
    const isolation: FailureCategory = "isolation-violation";
    const session: FailureCategory = "session-failure";
    const failing: FailureCategory = "tests-failing";
    const rejected: FailureCategory = "verifier-rejected";
    expect([isolation, session, failing, rejected]).toHaveLength(4);
  });
});

// ── markStoryPaused / markStoryPassed unaffected ─────────────────────────────

describe("markStoryPaused and markStoryPassed — failureCategory not affected", () => {
  test("markStoryPaused does not set failureCategory", () => {
    const prd = makePrd([makeStory("US-001")]);
    markStoryPaused(prd, "US-001");
    expect(prd.userStories[0].status).toBe("paused");
    expect(prd.userStories[0].failureCategory).toBeUndefined();
  });

  test("markStoryPassed does not set failureCategory", () => {
    const prd = makePrd([makeStory("US-001")]);
    markStoryPassed(prd, "US-001");
    expect(prd.userStories[0].status).toBe("passed");
    expect(prd.userStories[0].failureCategory).toBeUndefined();
  });
});
