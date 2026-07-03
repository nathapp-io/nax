/**
 * resetStoryToPending() / setStoryPriority() Unit Tests
 *
 * Backs the RETRY and PRIORITY queue commands (queue-check pipeline stage).
 */

import { describe, expect, test } from "bun:test";
import { getNextStory, resetStoryToPending, setStoryPriority } from "@/prd";
import type { PRD, UserStory } from "@/prd/types";

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

// ── resetStoryToPending() ───────────────────────────────────────────────────────

describe("resetStoryToPending()", () => {
  test("resets a failed story to pending and clears error state", () => {
    const prd = makePrd([
      makeStory("US-001", { status: "failed", attempts: 3, failureStage: "verify" }),
    ]);
    resetStoryToPending(prd, "US-001");

    const story = prd.userStories[0];
    expect(story.status).toBe("pending");
    expect(story.attempts).toBe(0);
  });

  test("resets a skipped story to pending", () => {
    const prd = makePrd([makeStory("US-001", { status: "skipped" })]);
    resetStoryToPending(prd, "US-001");
    expect(prd.userStories[0].status).toBe("pending");
  });

  test("restores initial routing rung and clears escalations", () => {
    const prd = makePrd([
      makeStory("US-001", {
        status: "failed",
        routing: { modelTier: "powerful", agent: "codex", initialModelTier: "fast", initialAgent: "claude" },
        escalations: [{ fromTier: "fast", toTier: "powerful", reason: "retry", timestamp: "now" }],
      }),
    ]);
    resetStoryToPending(prd, "US-001");

    const story = prd.userStories[0];
    expect(story.routing?.modelTier).toBe("fast");
    expect(story.routing?.agent).toBe("claude");
    expect(story.escalations).toEqual([]);
  });

  test("does nothing when story ID is not found", () => {
    const prd = makePrd([makeStory("US-001", { status: "failed" })]);
    resetStoryToPending(prd, "US-999");
    expect(prd.userStories[0].status).toBe("failed");
  });

  test("is a no-op for a story that is already pending", () => {
    const prd = makePrd([makeStory("US-001", { status: "pending" })]);
    resetStoryToPending(prd, "US-001");
    expect(prd.userStories[0].status).toBe("pending");
  });
});

// ── setStoryPriority() ──────────────────────────────────────────────────────────

describe("setStoryPriority()", () => {
  test("sets the priority field on the matching story", () => {
    const prd = makePrd([makeStory("US-001"), makeStory("US-002")]);
    setStoryPriority(prd, "US-002", 10);

    expect(prd.userStories[0].priority).toBeUndefined();
    expect(prd.userStories[1].priority).toBe(10);
  });

  test("does nothing when story ID is not found", () => {
    const prd = makePrd([makeStory("US-001")]);
    setStoryPriority(prd, "US-999", 10);
    expect(prd.userStories[0].priority).toBeUndefined();
  });

  test("overwrites an existing priority value", () => {
    const prd = makePrd([makeStory("US-001", { priority: 3 })]);
    setStoryPriority(prd, "US-001", -1);
    expect(prd.userStories[0].priority).toBe(-1);
  });
});

// ── getNextStory() priority ordering ────────────────────────────────────────────

describe("getNextStory() priority ordering", () => {
  test("picks the highest-priority eligible story over array order", () => {
    const prd = makePrd([makeStory("US-001", { priority: 1 }), makeStory("US-002", { priority: 5 })]);
    expect(getNextStory(prd)?.id).toBe("US-002");
  });

  test("falls back to array order (FIFO) when priorities are equal or unset", () => {
    const prd = makePrd([makeStory("US-001"), makeStory("US-002")]);
    expect(getNextStory(prd)?.id).toBe("US-001");
  });

  test("treats unset priority as 0 — a prioritized story wins over an unset one", () => {
    const prd = makePrd([makeStory("US-001"), makeStory("US-002", { priority: 1 })]);
    expect(getNextStory(prd)?.id).toBe("US-002");
  });

  test("still respects dependency/status eligibility before priority", () => {
    const prd = makePrd([
      makeStory("US-001", { priority: 10, dependencies: ["US-002"] }),
      makeStory("US-002", { priority: 1 }),
    ]);
    // US-001 has higher priority but is blocked on US-002, which hasn't passed yet.
    expect(getNextStory(prd)?.id).toBe("US-002");
  });
});
