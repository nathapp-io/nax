/**
 * Unit tests for paused-story-prompts.ts.
 *
 * On re-run each paused story is offered resume / skip / keep. A resume puts
 * the story back in the queue and keeps its `storyGitRef`: every story runs in
 * the same shared checkout (US-004 removed the worktree isolation paths), so
 * the ref captured at the start of the story is still the right diff base.
 */

import { describe, expect, mock, test } from "bun:test";
import { makeInteractionChain } from "@test/helpers";
import { promptForPausedStories } from "@/execution/lifecycle/paused-story-prompts";
import type { InteractionChain } from "@/interaction/chain";
import type { PRD, UserStory } from "@/prd/types";

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
  return makeInteractionChain({
    prompt: mock(async () => ({ id: "ix-1", action, createdAt: Date.now() })),
    applyFallback: mock((_response: unknown, _fallback: string) => action),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("promptForPausedStories — resume", () => {
  test("AC-10: a resumed story is set back to pending", async () => {
    const story = makeStory("US-001", { storyGitRef: "abc123" });
    const prd = makePrd([story]);

    await promptForPausedStories(prd, makeChain("resume"), "feat");

    expect(story.status).toBe("pending");
  });

  test("AC-11: a resumed story keeps its storyGitRef", async () => {
    const story = makeStory("US-001", { storyGitRef: "abc123" });
    const prd = makePrd([story]);

    await promptForPausedStories(prd, makeChain("resume"), "feat");

    expect(story.storyGitRef).toBe("abc123");
  });

  test("AC-12: a resumed story is listed in summary.resumed", async () => {
    const story = makeStory("US-001", { storyGitRef: "abc123" });
    const prd = makePrd([story]);

    const summary = await promptForPausedStories(prd, makeChain("resume"), "feat");

    expect(summary.resumed).toEqual(["US-001"]);
    expect(summary.skipped).toEqual([]);
    expect(summary.kept).toEqual([]);
  });
});

describe("promptForPausedStories — skip and keep", () => {
  test("a skipped story is marked skipped and keeps its storyGitRef", async () => {
    const story = makeStory("US-001", { storyGitRef: "abc123" });
    const prd = makePrd([story]);

    const summary = await promptForPausedStories(prd, makeChain("skip"), "feat");

    expect(story.status).toBe("skipped");
    expect(story.storyGitRef).toBe("abc123");
    expect(summary.skipped).toEqual(["US-001"]);
  });

  test("a kept story stays paused and keeps its storyGitRef", async () => {
    const story = makeStory("US-001", { storyGitRef: "abc123" });
    const prd = makePrd([story]);

    const summary = await promptForPausedStories(prd, makeChain("keep"), "feat");

    expect(story.status).toBe("paused");
    expect(story.storyGitRef).toBe("abc123");
    expect(summary.kept).toEqual(["US-001"]);
  });
});
