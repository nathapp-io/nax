/**
 * Tests for resetPostRunStatus() calls in PRD story-status mutation functions (US-003)
 *
 * Verifies that backward transitions from "passed" trigger resetPostRunStatus()
 * on the provided statusWriter, while forward transitions do not.
 *
 * AC5: markStoryFailed() calls resetPostRunStatus() when story's current status is "passed"
 * AC6: markStoryAsBlocked() calls resetPostRunStatus() when story's current status is "passed"
 * AC7: markStoryPassed() does NOT call resetPostRunStatus() when story's current status is "pending"
 */

import { describe, expect, mock, test } from "bun:test";
import { markStoryFailed, markStoryPassed } from "../../../src/prd/index";
import { markStoryAsBlocked } from "../../../src/prd/types";
import type { PRD, UserStory } from "../../../src/prd";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStory(id: string, status: UserStory["status"]): UserStory {
  return {
    id,
    title: `Story ${id}`,
    description: "Test story",
    acceptanceCriteria: ["AC-1"],
    tags: [],
    dependencies: [],
    status,
    passes: status === "passed",
    escalations: [],
    attempts: status === "passed" ? 1 : 0,
    priorErrors: [],
  };
}

function makePRD(stories: UserStory[]): PRD {
  return {
    project: "test-project",
    feature: "test-feature",
    branchName: "test-branch",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: stories,
  };
}

function makeStatusWriter() {
  return {
    resetPostRunStatus: mock(() => {}),
  };
}

// ---------------------------------------------------------------------------
// AC5: markStoryFailed() — backward transition from "passed" triggers reset
// ---------------------------------------------------------------------------

describe("markStoryFailed - AC5: resetPostRunStatus when story was passed", () => {
  test("calls resetPostRunStatus when story's previous status was passed", () => {
    const story = makeStory("US-001", "passed");
    const prd = makePRD([story]);
    const sw = makeStatusWriter();

    markStoryFailed(prd, "US-001", undefined, undefined, sw);

    expect(sw.resetPostRunStatus).toHaveBeenCalledTimes(1);
  });

  test("story status is set to failed regardless of resetPostRunStatus", () => {
    const story = makeStory("US-001", "passed");
    const prd = makePRD([story]);
    const sw = makeStatusWriter();

    markStoryFailed(prd, "US-001", undefined, undefined, sw);

    expect(prd.userStories[0].status).toBe("failed");
  });

  test("does NOT call resetPostRunStatus when story's previous status was failed (not backward from passed)", () => {
    const story = makeStory("US-001", "failed");
    const prd = makePRD([story]);
    const sw = makeStatusWriter();

    markStoryFailed(prd, "US-001", undefined, undefined, sw);

    expect(sw.resetPostRunStatus).not.toHaveBeenCalled();
  });

  test("does NOT call resetPostRunStatus when story's previous status was pending", () => {
    const story = makeStory("US-001", "pending");
    const prd = makePRD([story]);
    const sw = makeStatusWriter();

    markStoryFailed(prd, "US-001", undefined, undefined, sw);

    expect(sw.resetPostRunStatus).not.toHaveBeenCalled();
  });

  test("does NOT call resetPostRunStatus when story's previous status was in-progress", () => {
    const story = makeStory("US-001", "in-progress");
    const prd = makePRD([story]);
    const sw = makeStatusWriter();

    markStoryFailed(prd, "US-001", undefined, undefined, sw);

    expect(sw.resetPostRunStatus).not.toHaveBeenCalled();
  });

  test("does NOT call resetPostRunStatus when statusWriter is not provided", () => {
    // Verifies the parameter is truly optional (no error thrown)
    const story = makeStory("US-001", "passed");
    const prd = makePRD([story]);

    expect(() => markStoryFailed(prd, "US-001")).not.toThrow();
  });

  test("does NOT call resetPostRunStatus when story ID is not found", () => {
    const story = makeStory("US-001", "passed");
    const prd = makePRD([story]);
    const sw = makeStatusWriter();

    markStoryFailed(prd, "US-UNKNOWN", undefined, undefined, sw);

    expect(sw.resetPostRunStatus).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC6: markStoryAsBlocked() — backward transition from "passed" triggers reset
// ---------------------------------------------------------------------------

describe("markStoryAsBlocked - AC6: resetPostRunStatus when story was passed", () => {
  test("calls resetPostRunStatus when story's previous status was passed", () => {
    const story = makeStory("US-001", "passed");
    const prd = makePRD([story]);
    const sw = makeStatusWriter();

    markStoryAsBlocked(prd, "US-001", "dependency failed", sw);

    expect(sw.resetPostRunStatus).toHaveBeenCalledTimes(1);
  });

  test("story status is set to blocked regardless of resetPostRunStatus", () => {
    const story = makeStory("US-001", "passed");
    const prd = makePRD([story]);
    const sw = makeStatusWriter();

    markStoryAsBlocked(prd, "US-001", "dependency failed", sw);

    expect(prd.userStories[0].status).toBe("blocked");
  });

  test("does NOT call resetPostRunStatus when story's previous status was pending", () => {
    const story = makeStory("US-001", "pending");
    const prd = makePRD([story]);
    const sw = makeStatusWriter();

    markStoryAsBlocked(prd, "US-001", "dependency failed", sw);

    expect(sw.resetPostRunStatus).not.toHaveBeenCalled();
  });

  test("does NOT call resetPostRunStatus when story's previous status was failed", () => {
    const story = makeStory("US-001", "failed");
    const prd = makePRD([story]);
    const sw = makeStatusWriter();

    markStoryAsBlocked(prd, "US-001", "dependency failed", sw);

    expect(sw.resetPostRunStatus).not.toHaveBeenCalled();
  });

  test("does NOT call resetPostRunStatus when story's previous status was in-progress", () => {
    const story = makeStory("US-001", "in-progress");
    const prd = makePRD([story]);
    const sw = makeStatusWriter();

    markStoryAsBlocked(prd, "US-001", "dependency failed", sw);

    expect(sw.resetPostRunStatus).not.toHaveBeenCalled();
  });

  test("does NOT call resetPostRunStatus when statusWriter is not provided", () => {
    const story = makeStory("US-001", "passed");
    const prd = makePRD([story]);

    expect(() => markStoryAsBlocked(prd, "US-001", "dependency failed")).not.toThrow();
  });

  test("does NOT call resetPostRunStatus when story ID is not found", () => {
    const story = makeStory("US-001", "passed");
    const prd = makePRD([story]);
    const sw = makeStatusWriter();

    markStoryAsBlocked(prd, "US-UNKNOWN", "dependency failed", sw);

    expect(sw.resetPostRunStatus).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC7: markStoryPassed() — forward transition does NOT trigger reset
// ---------------------------------------------------------------------------

describe("markStoryPassed - AC7: does NOT call resetPostRunStatus for forward transitions", () => {
  test("does NOT call resetPostRunStatus when story's previous status was pending", () => {
    const story = makeStory("US-001", "pending");
    const prd = makePRD([story]);
    const sw = makeStatusWriter();

    markStoryPassed(prd, "US-001", sw);

    expect(sw.resetPostRunStatus).not.toHaveBeenCalled();
  });

  test("does NOT call resetPostRunStatus when story's previous status was in-progress", () => {
    const story = makeStory("US-001", "in-progress");
    const prd = makePRD([story]);
    const sw = makeStatusWriter();

    markStoryPassed(prd, "US-001", sw);

    expect(sw.resetPostRunStatus).not.toHaveBeenCalled();
  });

  test("does NOT call resetPostRunStatus when story's previous status was failed", () => {
    const story = makeStory("US-001", "failed");
    const prd = makePRD([story]);
    const sw = makeStatusWriter();

    markStoryPassed(prd, "US-001", sw);

    expect(sw.resetPostRunStatus).not.toHaveBeenCalled();
  });

  test("story status is set to passed for forward transition", () => {
    const story = makeStory("US-001", "pending");
    const prd = makePRD([story]);
    const sw = makeStatusWriter();

    markStoryPassed(prd, "US-001", sw);

    expect(prd.userStories[0].status).toBe("passed");
    expect(prd.userStories[0].passes).toBe(true);
  });

  test("does NOT call resetPostRunStatus when statusWriter is not provided", () => {
    const story = makeStory("US-001", "pending");
    const prd = makePRD([story]);

    expect(() => markStoryPassed(prd, "US-001")).not.toThrow();
  });
});
