/**
 * resetFailedStoriesToPending() Unit Tests
 *
 * Verifies that failed stories are reset to pending on re-run so the
 * execution loop can pick them up again.
 */

import { describe, expect, test } from "bun:test";
import { resetFailedStoriesToPending } from "../../../src/prd";
import type { PRD, UserStory } from "../../../src/prd/types";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeStory(id: string, overrides: Partial<UserStory> = {}): UserStory {
  return {
    id,
    title: `Story ${id}`,
    description: "Test story",
    acceptanceCriteria: [],
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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("resetFailedStoriesToPending()", () => {
  test("resets a failed story to pending", () => {
    const prd = makePrd([makeStory("US-001", { status: "failed", attempts: 1 })]);
    resetFailedStoriesToPending(prd);
    expect(prd.userStories[0].status).toBe("pending");
  });

  test("resets all failed stories when multiple exist", () => {
    const prd = makePrd([
      makeStory("US-001", { status: "failed", attempts: 2 }),
      makeStory("US-002", { status: "failed", attempts: 1 }),
    ]);
    resetFailedStoriesToPending(prd);
    expect(prd.userStories[0].status).toBe("pending");
    expect(prd.userStories[1].status).toBe("pending");
  });

  test("preserves attempts count after reset", () => {
    const prd = makePrd([makeStory("US-001", { status: "failed", attempts: 3 })]);
    resetFailedStoriesToPending(prd);
    expect(prd.userStories[0].attempts).toBe(3);
  });

  test("does not touch stories with status passed", () => {
    const prd = makePrd([makeStory("US-001", { status: "passed", passes: true })]);
    resetFailedStoriesToPending(prd);
    expect(prd.userStories[0].status).toBe("passed");
  });

  test("does not touch stories with status pending", () => {
    const prd = makePrd([makeStory("US-001", { status: "pending" })]);
    resetFailedStoriesToPending(prd);
    expect(prd.userStories[0].status).toBe("pending");
  });

  test("does not touch stories with status skipped", () => {
    const prd = makePrd([makeStory("US-001", { status: "skipped" })]);
    resetFailedStoriesToPending(prd);
    expect(prd.userStories[0].status).toBe("skipped");
  });

  test("does not touch stories with status blocked", () => {
    const prd = makePrd([makeStory("US-001", { status: "blocked" })]);
    resetFailedStoriesToPending(prd);
    expect(prd.userStories[0].status).toBe("blocked");
  });

  test("does not reset regression-failed stories (only exact 'failed' status)", () => {
    const prd = makePrd([makeStory("US-001", { status: "regression-failed" as UserStory["status"] })]);
    resetFailedStoriesToPending(prd);
    expect(prd.userStories[0].status).toBe("regression-failed");
  });

  test("returns array of reset stories (non-empty when at least one was reset)", () => {
    const prd = makePrd([makeStory("US-001", { status: "failed", attempts: 1 })]);
    const result = resetFailedStoriesToPending(prd);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("US-001");
  });

  test("returns empty array when no stories were reset", () => {
    const prd = makePrd([makeStory("US-001", { status: "pending" })]);
    expect(resetFailedStoriesToPending(prd)).toHaveLength(0);
  });

  test("returns empty array for empty PRD", () => {
    const prd = makePrd([]);
    expect(resetFailedStoriesToPending(prd)).toHaveLength(0);
  });

  test("worktree mode: clears storyGitRef for each reset story", () => {
    const prd = makePrd([
      makeStory("US-001", { status: "failed", storyGitRef: "abc123" }),
      makeStory("US-002", { status: "failed", storyGitRef: "def456" }),
    ]);
    resetFailedStoriesToPending(prd, false, "worktree");
    expect(prd.userStories[0].storyGitRef).toBeUndefined();
    expect(prd.userStories[1].storyGitRef).toBeUndefined();
  });

  test("worktree mode: does not clear storyGitRef for non-failed stories", () => {
    const prd = makePrd([
      makeStory("US-001", { status: "passed", passes: true, storyGitRef: "abc123" }),
      makeStory("US-002", { status: "failed", storyGitRef: "def456" }),
    ]);
    resetFailedStoriesToPending(prd, false, "worktree");
    expect(prd.userStories[0].storyGitRef).toBe("abc123");
    expect(prd.userStories[1].storyGitRef).toBeUndefined();
  });

  test("shared mode: does not clear storyGitRef (legacy behaviour)", () => {
    const prd = makePrd([makeStory("US-001", { status: "failed", storyGitRef: "abc123" })]);
    resetFailedStoriesToPending(prd, false, "shared");
    expect(prd.userStories[0].storyGitRef).toBe("abc123");
  });

  test("mixed statuses — only failed stories are reset", () => {
    const prd = makePrd([
      makeStory("US-001", { status: "passed", passes: true }),
      makeStory("US-002", { status: "failed", attempts: 1 }),
      makeStory("US-003", { status: "pending" }),
      makeStory("US-004", { status: "skipped" }),
    ]);
    resetFailedStoriesToPending(prd);
    expect(prd.userStories[0].status).toBe("passed");
    expect(prd.userStories[1].status).toBe("pending");
    expect(prd.userStories[2].status).toBe("pending");
    expect(prd.userStories[3].status).toBe("skipped");
  });
});
