/**
 * resetStoryToPending() / setStoryPriority() Unit Tests
 *
 * Backs the RETRY and PRIORITY queue commands (queue-check pipeline stage).
 */

import { describe, expect, test } from "bun:test";
import { getNextStory, injectStory, resetStoryToPending, setStoryPriority } from "@/prd";
import { makePRD, makeStory } from "@test/helpers";

// ── resetStoryToPending() ───────────────────────────────────────────────────────

describe("resetStoryToPending()", () => {
  test("resets a failed story to pending and clears error state", () => {
    const prd = makePRD({
      userStories: [makeStory({ id: "US-001", status: "failed", attempts: 3, failureStage: "verify" })],
    });
    resetStoryToPending(prd, "US-001");

    const story = prd.userStories[0];
    expect(story.status).toBe("pending");
    expect(story.attempts).toBe(0);
  });

  test("resets a skipped story to pending", () => {
    const prd = makePRD({ userStories: [makeStory({ id: "US-001", status: "skipped" })] });
    resetStoryToPending(prd, "US-001");
    expect(prd.userStories[0].status).toBe("pending");
  });

  test("restores initial routing rung and clears escalations", () => {
    const prd = makePRD({
      userStories: [
        makeStory({
          id: "US-001",
          status: "failed",
          routing: {
            modelTier: "powerful",
            agent: "codex",
            initialModelTier: "fast",
            initialAgent: "claude",
            complexity: "complex",
            testStrategy: "test-after",
            reasoning: "initial routing fixture",
          },
          escalations: [{ fromTier: "fast", toTier: "powerful", reason: "retry", timestamp: "now" }],
        }),
      ],
    });
    resetStoryToPending(prd, "US-001");

    const story = prd.userStories[0];
    expect(story.routing?.modelTier).toBe("fast");
    expect(story.routing?.agent).toBe("claude");
    expect(story.escalations).toEqual([]);
  });

  test("does nothing when story ID is not found", () => {
    const prd = makePRD({ userStories: [makeStory({ id: "US-001", status: "failed" })] });
    resetStoryToPending(prd, "US-999");
    expect(prd.userStories[0].status).toBe("failed");
  });

  test("is a no-op for a story that is already pending", () => {
    const prd = makePRD({ userStories: [makeStory({ id: "US-001", status: "pending" })] });
    resetStoryToPending(prd, "US-001");
    expect(prd.userStories[0].status).toBe("pending");
  });
});

// ── setStoryPriority() ──────────────────────────────────────────────────────────

describe("setStoryPriority()", () => {
  test("sets the priority field on the matching story", () => {
    const prd = makePRD({ userStories: [makeStory({ id: "US-001" }), makeStory({ id: "US-002" })] });
    setStoryPriority(prd, "US-002", 10);

    expect(prd.userStories[0].priority).toBeUndefined();
    expect(prd.userStories[1].priority).toBe(10);
  });

  test("does nothing when story ID is not found", () => {
    const prd = makePRD({ userStories: [makeStory({ id: "US-001" })] });
    setStoryPriority(prd, "US-999", 10);
    expect(prd.userStories[0].priority).toBeUndefined();
  });

  test("overwrites an existing priority value", () => {
    const prd = makePRD({ userStories: [makeStory({ id: "US-001", priority: 3 })] });
    setStoryPriority(prd, "US-001", -1);
    expect(prd.userStories[0].priority).toBe(-1);
  });
});

// ── injectStory() ────────────────────────────────────────────────────────────────

describe("injectStory()", () => {
  test("appends a new story to the PRD", () => {
    const prd = makePRD({ userStories: [makeStory({ id: "US-001" })] });
    injectStory(prd, makeStory({ id: "US-002", title: "Injected story" }));

    expect(prd.userStories).toHaveLength(2);
    expect(prd.userStories[1].id).toBe("US-002");
    expect(prd.userStories[1].title).toBe("Injected story");
  });

  test("throws when the story id already exists in the PRD", () => {
    const prd = makePRD({ userStories: [makeStory({ id: "US-001" })] });
    expect(() => injectStory(prd, makeStory({ id: "US-001" }))).toThrow(/already exists/);
    expect(prd.userStories).toHaveLength(1);
  });
});

// ── getNextStory() priority ordering ────────────────────────────────────────────

describe("getNextStory() priority ordering", () => {
  test("picks the highest-priority eligible story over array order", () => {
    const prd = makePRD({
      userStories: [makeStory({ id: "US-001", priority: 1 }), makeStory({ id: "US-002", priority: 5 })],
    });
    expect(getNextStory(prd)?.id).toBe("US-002");
  });

  test("falls back to array order (FIFO) when priorities are equal or unset", () => {
    const prd = makePRD({ userStories: [makeStory({ id: "US-001" }), makeStory({ id: "US-002" })] });
    expect(getNextStory(prd)?.id).toBe("US-001");
  });

  test("treats unset priority as 0 — a prioritized story wins over an unset one", () => {
    const prd = makePRD({
      userStories: [makeStory({ id: "US-001" }), makeStory({ id: "US-002", priority: 1 })],
    });
    expect(getNextStory(prd)?.id).toBe("US-002");
  });

  test("still respects dependency/status eligibility before priority", () => {
    const prd = makePRD({
      userStories: [
        makeStory({ id: "US-001", priority: 10, dependencies: ["US-002"] }),
        makeStory({ id: "US-002", priority: 1 }),
      ],
    });
    // US-001 has higher priority but is blocked on US-002, which hasn't passed yet.
    expect(getNextStory(prd)?.id).toBe("US-002");
  });
});
