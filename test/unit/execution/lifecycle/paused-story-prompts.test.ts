/**
 * Unit tests for paused-story-prompts.ts (EXEC-002 / US-004)
 *
 * Covers:
 * - In "worktree" mode, resumed stories have storyGitRef cleared
 * - In "shared" mode, storyGitRef is NOT cleared
 * - Skipped and kept stories are not affected
 */

import { describe, expect, mock, test } from "bun:test";
import { promptForPausedStories } from "../../../../src/execution/lifecycle/paused-story-prompts";
import type { InteractionChain } from "../../../../src/interaction/chain";
import type { PRD, UserStory } from "../../../../src/prd/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStory(id: string, overrides: Partial<UserStory> = {}): UserStory {
  return {
    id,
    title: `Story ${id}`,
    description: "",
    acceptanceCriteria: [],
    tags: [],
    dependencies: [],
    status: "paused",
    passes: false,
    escalations: [],
    attempts: 1,
    ...overrides,
  };
}

function makePrd(stories: UserStory[]): PRD {
  return {
    project: "test",
    feature: "test-feature",
    branchName: "main",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: stories,
  };
}

function makeChain(action: string): InteractionChain {
  return {
    prompt: mock(async () => ({ id: "ix-1", action, createdAt: Date.now() })),
    applyFallback: mock((_response: unknown, _fallback: string) => action),
  } as unknown as InteractionChain;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("promptForPausedStories — worktree mode storyGitRef cleanup (EXEC-002)", () => {
  test("worktree mode: clears storyGitRef when story is resumed", async () => {
    const story = makeStory("US-001", { storyGitRef: "abc123" });
    const prd = makePrd([story]);
    const chain = makeChain("resume");

    await promptForPausedStories(prd, chain, "test-feature", "worktree");

    expect(story.status).toBe("pending");
    expect(story.storyGitRef).toBeUndefined();
  });

  test("shared mode: does NOT clear storyGitRef when story is resumed", async () => {
    const story = makeStory("US-001", { storyGitRef: "abc123" });
    const prd = makePrd([story]);
    const chain = makeChain("resume");

    await promptForPausedStories(prd, chain, "test-feature", "shared");

    expect(story.status).toBe("pending");
    expect(story.storyGitRef).toBe("abc123");
  });

  test("storyGitRef not cleared when story is skipped (even in worktree mode)", async () => {
    const story = makeStory("US-001", { storyGitRef: "abc123" });
    const prd = makePrd([story]);
    const chain = makeChain("skip");

    await promptForPausedStories(prd, chain, "test-feature", "worktree");

    expect(story.status).toBe("skipped");
    expect(story.storyGitRef).toBe("abc123");
  });

  test("storyGitRef not cleared when story is kept paused (even in worktree mode)", async () => {
    const story = makeStory("US-001", { storyGitRef: "abc123" });
    const prd = makePrd([story]);
    // "keep" action → story stays paused
    const chain = makeChain("keep");

    await promptForPausedStories(prd, chain, "test-feature", "worktree");

    expect(story.status).toBe("paused");
    expect(story.storyGitRef).toBe("abc123");
  });

  test("no storyIsolation param: storyGitRef is NOT cleared (backward compat)", async () => {
    const story = makeStory("US-001", { storyGitRef: "abc123" });
    const prd = makePrd([story]);
    const chain = makeChain("resume");

    await promptForPausedStories(prd, chain, "test-feature");

    expect(story.status).toBe("pending");
    expect(story.storyGitRef).toBe("abc123");
  });
});
