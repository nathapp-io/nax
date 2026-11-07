/**
 * Tests for story-selector module (US-002)
 *
 * Tests selectNextStories() and groupStoriesByDependencies() functions
 */

import { describe, expect, test } from "bun:test";
import { byCodePoint } from "@nathapp/nax-agent/internal";
import { makePRD, makeStory } from "@test/helpers";
import { DEFAULT_CONFIG } from "@/config";
import type { StoryBatch } from "@/execution/batching";
import { groupStoriesByDependencies, selectNextStories } from "@/execution/story-selector";
import type { UserStory } from "@/prd/types";

/**
 * Helper to create a minimal UserStory for testing
 */
function createStory(id: string, dependencies: string[] = []): UserStory {
  return {
    id,
    title: `Story ${id}`,
    description: `Description for ${id}`,
    acceptanceCriteria: ["AC1"],
    tags: [],
    dependencies,
    status: "pending",
    passes: false,
    escalations: [],
    attempts: 0,
  };
}

describe("groupStoriesByDependencies", () => {
  test("returns single batch for stories with no dependencies", () => {
    const stories = [createStory("US-001", []), createStory("US-002", []), createStory("US-003", [])];

    const batches = groupStoriesByDependencies(stories);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(3);
  });

  test("groups stories into dependency-ordered batches", () => {
    const stories = [createStory("US-001", []), createStory("US-002", ["US-001"]), createStory("US-003", ["US-002"])];

    const batches = groupStoriesByDependencies(stories);
    expect(batches).toHaveLength(3);
    expect(batches[0].map((s) => s.id)).toEqual(["US-001"]);
    expect(batches[1].map((s) => s.id)).toEqual(["US-002"]);
    expect(batches[2].map((s) => s.id)).toEqual(["US-003"]);
  });

  test("groups parallel-ready stories in same batch", () => {
    const stories = [createStory("US-001", []), createStory("US-002", ["US-001"]), createStory("US-003", ["US-001"])];

    const batches = groupStoriesByDependencies(stories);
    expect(batches).toHaveLength(2);
    expect(batches[0].map((s) => s.id)).toEqual(["US-001"]);
    expect(batches[1].map((s) => s.id).sort(byCodePoint)).toEqual(["US-002", "US-003"]);
  });

  test("handles single story", () => {
    const stories = [createStory("US-001", [])];
    const batches = groupStoriesByDependencies(stories);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
  });

  test("throws error on circular dependency", () => {
    const stories = [createStory("US-001", ["US-002"]), createStory("US-002", ["US-001"])];

    expect(() => groupStoriesByDependencies(stories)).toThrow("Circular dependency or missing dependency detected");
  });

  test("handles external dependencies (dependencies not in story list)", () => {
    const stories = [createStory("US-001", ["EXTERNAL-DEP"]), createStory("US-002", ["US-001"])];

    const batches = groupStoriesByDependencies(stories);
    expect(batches).toHaveLength(2);
    expect(batches[0].map((s) => s.id)).toEqual(["US-001"]);
    expect(batches[1].map((s) => s.id)).toEqual(["US-002"]);
  });
});

describe("selectNextStories — batch exhaustion", () => {
  test("returns null (not a null-selection object) when all batch stories are already passed", () => {
    const story = makeStory({ id: "s1", status: "passed", passes: true });
    const prd = makePRD({ userStories: [story] });
    const batch: StoryBatch[] = [{ stories: [story], isBatch: false }];
    const result = selectNextStories(prd, DEFAULT_CONFIG, batch, 0, null, true);
    // Must be null, NOT { selection: null, nextBatchIndex: 1 }
    expect(result).toBeNull();
  });

  test("returns null when batch plan is empty", () => {
    const prd = makePRD({ userStories: [] });
    const result = selectNextStories(prd, DEFAULT_CONFIG, [], 0, null, true);
    expect(result).toBeNull();
  });

  test("returns a valid selection when batch has pending stories", () => {
    const story = makeStory({ id: "s1", status: "pending", passes: false });
    const prd = makePRD({ userStories: [story] });
    const batch: StoryBatch[] = [{ stories: [story], isBatch: false }];
    const result = selectNextStories(prd, DEFAULT_CONFIG, batch, 0, null, true);
    expect(result).not.toBeNull();
    expect(result?.selection.story.id).toBe("s1");
  });
});

describe("selectNextStories — retry priority under useBatch:true (BUG-39)", () => {
  // getNextStory's own retry-priority logic is covered exhaustively in
  // prd-get-next-story.test.ts. This describe block covers the wiring bug
  // specifically: selectNextStories's "batch exhausted -> single-story
  // fallback" branch (and the analogous "no dispatchable stories" branch)
  // must actually pass lastStoryId through to getNextStory when useBatch is
  // true — previously the caller (unified-executor.ts) never set lastStoryId
  // at all under useBatch, so a transiently failed story could never win
  // retry-priority and was excluded from the normal "eligible" pool by its
  // own "failed" status, becoming terminal.
  test("batch plan exhausted: a failed story with retry budget is retried via the getNextStory fallback", () => {
    const failedStory = makeStory({ id: "s1", status: "failed", passes: false, attempts: 1 });
    const otherStory = makeStory({ id: "s2", status: "pending", passes: false });
    const prd = makePRD({ userStories: [failedStory, otherStory] });
    // currentBatchIndex (2) >= batchPlan.length (1) so this call takes the
    // "single-story fallback" branch (getNextStory), not the batch-plan branch.
    const batchPlan: StoryBatch[] = [{ stories: [otherStory], isBatch: false }];
    const result = selectNextStories(prd, DEFAULT_CONFIG, batchPlan, 2, "s1", true);

    expect(result).not.toBeNull();
    expect(result?.selection.story.id).toBe("s1");
  });

  test("no dispatchable stories in the current batch slot: retry-priority still applies via the fallback", () => {
    const failedStory = makeStory({ id: "s1", status: "failed", passes: false, attempts: 1 });
    const decomposedParent = makeStory({ id: "s2", status: "decomposed", passes: false });
    const prd = makePRD({ userStories: [failedStory, decomposedParent] });
    const batchPlan: StoryBatch[] = [{ stories: [decomposedParent], isBatch: false }];
    const result = selectNextStories(prd, DEFAULT_CONFIG, batchPlan, 0, "s1", true);

    expect(result).not.toBeNull();
    expect(result?.selection.story.id).toBe("s1");
    // Not consumed from the batch plan — a retry, not a plan advance.
    expect(result?.nextBatchIndex).toBe(0);
  });

  test("a lastStoryId that is no longer retry-eligible does not pre-empt the batch-plan branch", () => {
    // Regression guard for a variant that would satisfy the two tests above
    // while being subtly wrong: deleting the `retryStory.id === lastStoryId`
    // guard entirely (trusting getNextStory's own eligible-pool fallback as
    // if it were always a retry) makes selectNextStories always return a
    // single-story, isBatchExecution:false selection for ANY non-null
    // lastStoryId — silently killing the batch-plan branch even when
    // lastStoryId refers to a story that is done and not being retried.
    const done = makeStory({ id: "s1", status: "passed", passes: true });
    const a = makeStory({
      id: "s2",
      status: "pending",
      routing: { complexity: "simple", testStrategy: "test-after", modelTier: "fast", reasoning: "" },
    });
    const b = makeStory({
      id: "s3",
      status: "pending",
      routing: { complexity: "simple", testStrategy: "test-after", modelTier: "fast", reasoning: "" },
    });
    const prd = makePRD({ userStories: [done, a, b] });
    const batch: StoryBatch[] = [{ stories: [a, b], isBatch: true }];
    const result = selectNextStories(prd, DEFAULT_CONFIG, batch, 0, "s1", true);

    expect(result?.selection.isBatchExecution).toBe(true);
    expect(result?.selection.storiesToExecute.map((s) => s.id)).toEqual(["s2", "s3"]);
    expect(result?.nextBatchIndex).toBe(1);
  });

  test("an escalated-but-pending lastStoryId does not collapse a multi-story batch either", () => {
    // resolveRetryCandidate is deliberately narrower than getNextStory's own
    // resumability check: it only pre-empts for status:"failed". A story that
    // was escalated (handleTierEscalation leaves it "pending" with a non-empty
    // escalations[]) is also "resumable" per isResumableCurrentStory, but was
    // never excluded by the batch-plan filter (it only excludes "failed") — so
    // pre-empting for it bought nothing and would silently downgrade the whole
    // batch to one-story-at-a-time dispatch after the first escalation.
    const escalated = makeStory({
      id: "s1",
      status: "pending",
      attempts: 1,
      escalations: [{ fromTier: "fast", toTier: "balanced", reason: "test", timestamp: new Date().toISOString() }],
    });
    const a = makeStory({
      id: "s2",
      status: "pending",
      routing: { complexity: "simple", testStrategy: "test-after", modelTier: "fast", reasoning: "" },
    });
    const b = makeStory({
      id: "s3",
      status: "pending",
      routing: { complexity: "simple", testStrategy: "test-after", modelTier: "fast", reasoning: "" },
    });
    const prd = makePRD({ userStories: [escalated, a, b] });
    const batch: StoryBatch[] = [{ stories: [escalated, a, b], isBatch: true }];
    const result = selectNextStories(prd, DEFAULT_CONFIG, batch, 0, "s1", true);

    expect(result?.selection.isBatchExecution).toBe(true);
    expect(result?.selection.storiesToExecute.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
  });
});
