/**
 * PRD regression-failed status tests (RL-004)
 *
 * Tests that:
 * - 'regression-failed' is a valid StoryStatus value in the type union
 * - countStories correctly counts regression-failed stories
 * - isComplete returns false when stories are regression-failed
 * - isStalled accounts for regression-failed stories
 */

import { describe, expect, test } from "bun:test";
import { makePRD as makePRDHelper } from "@test/helpers";
import type { PRD, StoryStatus, UserStory } from "@/prd";
import { countStories, isComplete, isStalled } from "@/prd";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeStory(id: string, status: StoryStatus): UserStory {
  return {
    id,
    title: `Story ${id}`,
    description: "Test",
    acceptanceCriteria: [],
    tags: [],
    dependencies: [],
    status,
    passes: status === "passed",
    escalations: [],
    attempts: 1,
  };
}

function makePRD(stories: UserStory[]): PRD {
  return makePRDHelper({
    project: "test",
    feature: "test-feature",
    branchName: "test-branch",
    userStories: stories,
  });
}

// ---------------------------------------------------------------------------
// StoryStatus type (RL-004 AC3)
// ---------------------------------------------------------------------------

describe("StoryStatus type - regression-failed (RL-004)", () => {
  test("'regression-failed' is assignable to StoryStatus", () => {
    // TypeScript compile error until 'regression-failed' is added to StoryStatus.
    // This documents the required type addition.
    const status: StoryStatus = "regression-failed";
    expect(status).toBe("regression-failed");
  });

  test("a UserStory can be created with status 'regression-failed'", () => {
    const story = makeStory("US-001", "regression-failed");
    expect(story.status).toBe("regression-failed");
    expect(story.passes).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// countStories with regression-failed (RL-004 AC1 + AC2)
// ---------------------------------------------------------------------------

describe("countStories - regression-failed (RL-004)", () => {
  test("counts regression-failed story in the failed bucket", () => {
    const story = makeStory("US-001", "regression-failed");
    const prd = makePRD([story]);

    const counts = countStories(prd);

    expect(counts.failed).toBe(1);
  });

  test("does not count regression-failed story as passed", () => {
    const story = makeStory("US-001", "regression-failed");
    const prd = makePRD([story]);

    const counts = countStories(prd);

    expect(counts.passed).toBe(0);
  });

  test("does not count regression-failed story as pending", () => {
    const story = makeStory("US-001", "regression-failed");
    const prd = makePRD([story]);

    const counts = countStories(prd);

    expect(counts.pending).toBe(0);
  });

  test("counts mixed statuses correctly including regression-failed", () => {
    const prd = makePRD([
      makeStory("US-001", "passed"),
      makeStory("US-002", "regression-failed"),
      makeStory("US-003", "pending"),
    ]);

    const counts = countStories(prd);

    expect(counts.total).toBe(3);
    expect(counts.passed).toBe(1);
    expect(counts.failed).toBe(1);
    expect(counts.pending).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// isComplete with regression-failed
// ---------------------------------------------------------------------------

describe("isComplete - regression-failed (RL-004)", () => {
  test("returns false when any story is regression-failed", () => {
    const prd = makePRD([makeStory("US-001", "passed"), makeStory("US-002", "regression-failed")]);

    expect(isComplete(prd)).toBe(false);
  });

  test("returns false when all stories are regression-failed", () => {
    const prd = makePRD([makeStory("US-001", "regression-failed"), makeStory("US-002", "regression-failed")]);

    expect(isComplete(prd)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isStalled with regression-failed
// ---------------------------------------------------------------------------

describe("isStalled - regression-failed (RL-004)", () => {
  test("returns true when all remaining stories are regression-failed", () => {
    const prd = makePRD([makeStory("US-001", "passed"), makeStory("US-002", "regression-failed")]);

    expect(isStalled(prd)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isStalled - retryable failed stories (BUG-25)
// ---------------------------------------------------------------------------

describe("isStalled - a failed story with retry budget remaining is not terminal (BUG-25)", () => {
  test("returns false when the only remaining story is failed with attempts <= maxRetries", () => {
    const story = { ...makeStory("US-001", "failed"), attempts: 2 };
    const prd = makePRD([story]);

    expect(isStalled(prd, 3)).toBe(false);
  });

  test("returns true when the only remaining story is failed with attempts exhausted", () => {
    const story = { ...makeStory("US-001", "failed"), attempts: 4 };
    const prd = makePRD([story]);

    expect(isStalled(prd, 3)).toBe(true);
  });

  test("a retryable-failed story does not count toward blockedIds for a dependent story", () => {
    const retryable = { ...makeStory("US-001", "failed"), attempts: 1 };
    const dependent = { ...makeStory("US-002", "pending"), dependencies: ["US-001"] };
    const prd = makePRD([retryable, dependent]);

    // US-002 depends on a still-retryable US-001, not a terminally-blocked one —
    // must not be swept into "all remaining depend on blocked" via dependency chaining.
    expect(isStalled(prd, 3)).toBe(false);
  });

  test("uses the default maxRetries (12) when none is passed", () => {
    const story = { ...makeStory("US-001", "failed"), attempts: 5 };
    const prd = makePRD([story]);

    expect(isStalled(prd)).toBe(false);
  });

  test("exhausted-retry failed story still counts as terminal alongside other blocked stories", () => {
    const exhausted = { ...makeStory("US-001", "failed"), attempts: 10 };
    const blocked = makeStory("US-002", "blocked");
    const prd = makePRD([exhausted, blocked]);

    expect(isStalled(prd, 3)).toBe(true);
  });
});
