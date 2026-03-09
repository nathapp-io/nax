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
import { countStories, isComplete, isStalled } from "../../src/prd";
import type { PRD, StoryStatus, UserStory } from "../../src/prd";

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
  return {
    project: "test",
    feature: "test-feature",
    branchName: "test-branch",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: stories,
  } as unknown as PRD;
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
    const prd = makePRD([
      makeStory("US-001", "passed"),
      makeStory("US-002", "regression-failed"),
    ]);

    expect(isComplete(prd)).toBe(false);
  });

  test("returns false when all stories are regression-failed", () => {
    const prd = makePRD([
      makeStory("US-001", "regression-failed"),
      makeStory("US-002", "regression-failed"),
    ]);

    expect(isComplete(prd)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isStalled with regression-failed
// ---------------------------------------------------------------------------

describe("isStalled - regression-failed (RL-004)", () => {
  test("returns true when all remaining stories are regression-failed", () => {
    const prd = makePRD([
      makeStory("US-001", "passed"),
      makeStory("US-002", "regression-failed"),
    ]);

    expect(isStalled(prd)).toBe(true);
  });
});
