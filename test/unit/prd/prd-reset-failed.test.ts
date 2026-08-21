/**
 * resetFailedStoriesToPending() Unit Tests
 *
 * Verifies that failed stories are reset to pending on re-run so the
 * execution loop can pick them up again.
 */

import { describe, expect, test } from "bun:test";
import { resetFailedStoriesToPending } from "@/prd";
import type { PRD, PersistedRepoScopedFix, UserStory } from "@/prd/types";

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

  test("resets attempts count to 0 after reset", () => {
    const prd = makePrd([makeStory("US-001", { status: "failed", attempts: 3 })]);
    resetFailedStoriesToPending(prd);
    expect(prd.userStories[0].attempts).toBe(0);
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
    resetFailedStoriesToPending(prd, { storyIsolation: "worktree" });
    expect(prd.userStories[0].storyGitRef).toBeUndefined();
    expect(prd.userStories[1].storyGitRef).toBeUndefined();
  });

  test("worktree mode: does not clear storyGitRef for non-failed stories", () => {
    const prd = makePrd([
      makeStory("US-001", { status: "passed", passes: true, storyGitRef: "abc123" }),
      makeStory("US-002", { status: "failed", storyGitRef: "def456" }),
    ]);
    resetFailedStoriesToPending(prd, { storyIsolation: "worktree" });
    expect(prd.userStories[0].storyGitRef).toBe("abc123");
    expect(prd.userStories[1].storyGitRef).toBeUndefined();
  });

  test("shared mode: does not clear storyGitRef (legacy behaviour)", () => {
    const prd = makePrd([makeStory("US-001", { status: "failed", storyGitRef: "abc123" })]);
    resetFailedStoriesToPending(prd, { storyIsolation: "shared" });
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

  // ── Tier / agent restoration (ADR-025 gap #4) ─────────────────────────────

  test("resetMode 'initial' restores origin tier/agent, clears escalations, resets attempts", () => {
    const story = makeStory("US-001", {
      status: "failed",
      attempts: 5,
      escalations: [{ fromTier: "fast", toTier: "powerful", reason: "x", timestamp: "t" }],
      routing: {
        complexity: "complex",
        modelTier: "powerful",
        testStrategy: "test-after",
        reasoning: "x",
        agent: "codex",
        initialModelTier: "fast",
        initialAgent: "claude",
      },
    });
    const prd = makePrd([story]);

    resetFailedStoriesToPending(prd, { resetMode: "initial" });

    expect(story.status).toBe("pending");
    expect(story.attempts).toBe(0);
    expect(story.escalations).toEqual([]);
    expect(story.routing?.modelTier).toBe("fast");
    expect(story.routing?.agent).toBe("claude");
  });

  test("resetMode 'last' keeps final tier/agent + escalations but resets attempts", () => {
    const story = makeStory("US-001", {
      status: "failed",
      attempts: 5,
      escalations: [{ fromTier: "fast", toTier: "powerful", reason: "x", timestamp: "t" }],
      routing: {
        complexity: "complex",
        modelTier: "powerful",
        testStrategy: "test-after",
        reasoning: "x",
        agent: "codex",
        initialModelTier: "fast",
        initialAgent: "claude",
      },
    });
    const prd = makePrd([story]);

    resetFailedStoriesToPending(prd, { resetMode: "last" });

    expect(story.status).toBe("pending");
    expect(story.attempts).toBe(0);
    expect(story.escalations.length).toBe(1);
    expect(story.routing?.modelTier).toBe("powerful");
    expect(story.routing?.agent).toBe("codex");
  });

  test("resetMode 'initial' on single-agent story resets tier but leaves agent undefined", () => {
    const story = makeStory("US-001", {
      status: "failed",
      attempts: 4,
      escalations: [{ fromTier: "fast", toTier: "balanced", reason: "x", timestamp: "t" }],
      routing: {
        complexity: "medium",
        modelTier: "balanced",
        testStrategy: "test-after",
        reasoning: "x",
        initialModelTier: "fast",
      },
    });
    const prd = makePrd([story]);

    resetFailedStoriesToPending(prd, { resetMode: "initial" });

    expect(story.attempts).toBe(0);
    expect(story.routing?.modelTier).toBe("fast");
    expect(story.routing?.agent).toBeUndefined();
    expect(story.escalations).toEqual([]);
  });

  // US-001 / #1654 — repoScopedFixes must clear under the same conditions as storyGitRef
  describe("repoScopedFixes reset invariant", () => {
    const fix: PersistedRepoScopedFix = {
      triggeringTests: ["src/foo.test.ts::reproduces bug"],
      filesChanged: ["src/foo.ts"],
      findingsCleared: true,
    };
    const fixX: PersistedRepoScopedFix = {
      triggeringTests: ["x.test.ts::y"],
      filesChanged: ["src/x.ts"],
      findingsCleared: false,
    };

    test("AC3: resetRef=true clears repoScopedFixes on every reset story", () => {
      const prd = makePrd([
        makeStory("US-001", {
          status: "failed",
          storyGitRef: "abc123",
          repoScopedFixes: [fix],
        }),
        makeStory("US-002", {
          status: "failed",
          storyGitRef: "def456",
          repoScopedFixes: [fixX],
        }),
      ]);

      resetFailedStoriesToPending(prd, { resetRef: true });

      expect(prd.userStories[0].repoScopedFixes).toBeUndefined();
      expect(prd.userStories[0].storyGitRef).toBeUndefined();
      expect(prd.userStories[1].repoScopedFixes).toBeUndefined();
      expect(prd.userStories[1].storyGitRef).toBeUndefined();
    });

    test("AC4: storyIsolation='worktree' with default resetRef clears repoScopedFixes", () => {
      const prd = makePrd([
        makeStory("US-001", {
          status: "failed",
          storyGitRef: "abc123",
          repoScopedFixes: [fix],
        }),
      ]);

      resetFailedStoriesToPending(prd, { storyIsolation: "worktree" });

      expect(prd.userStories[0].repoScopedFixes).toBeUndefined();
      expect(prd.userStories[0].storyGitRef).toBeUndefined();
    });

    test("AC5: empty opts leaves repoScopedFixes untouched on failed stories", () => {
      const prd = makePrd([
        makeStory("US-001", {
          status: "failed",
          storyGitRef: "abc123",
          repoScopedFixes: [fix],
        }),
      ]);

      resetFailedStoriesToPending(prd, {});

      expect(prd.userStories[0].repoScopedFixes).toEqual([fix]);
      expect(prd.userStories[0].storyGitRef).toBe("abc123");
    });

    test("AC5: shared isolation (legacy default) leaves repoScopedFixes untouched", () => {
      const prd = makePrd([
        makeStory("US-001", {
          status: "failed",
          storyGitRef: "abc123",
          repoScopedFixes: [fix],
        }),
      ]);

      resetFailedStoriesToPending(prd, { storyIsolation: "shared" });

      expect(prd.userStories[0].repoScopedFixes).toEqual([fix]);
      expect(prd.userStories[0].storyGitRef).toBe("abc123");
    });

    test("AC6: resetRef=true leaves repoScopedFixes untouched on passed stories", () => {
      const prd = makePrd([
        makeStory("US-001", {
          status: "passed",
          passes: true,
          storyGitRef: "abc123",
          repoScopedFixes: [fix],
        }),
        makeStory("US-002", {
          status: "failed",
          storyGitRef: "def456",
          repoScopedFixes: [fix],
        }),
      ]);

      resetFailedStoriesToPending(prd, { resetRef: true });

      expect(prd.userStories[0].repoScopedFixes).toEqual([fix]);
      expect(prd.userStories[0].storyGitRef).toBe("abc123");
      expect(prd.userStories[1].repoScopedFixes).toBeUndefined();
      expect(prd.userStories[1].storyGitRef).toBeUndefined();
    });

    test("worktree isolation leaves repoScopedFixes untouched on passed stories", () => {
      const prd = makePrd([
        makeStory("US-001", {
          status: "passed",
          passes: true,
          storyGitRef: "abc123",
          repoScopedFixes: [fix],
        }),
        makeStory("US-002", {
          status: "failed",
          storyGitRef: "def456",
          repoScopedFixes: [fix],
        }),
      ]);

      resetFailedStoriesToPending(prd, { storyIsolation: "worktree" });

      expect(prd.userStories[0].repoScopedFixes).toEqual([fix]);
      expect(prd.userStories[0].storyGitRef).toBe("abc123");
      expect(prd.userStories[1].repoScopedFixes).toBeUndefined();
      expect(prd.userStories[1].storyGitRef).toBeUndefined();
    });
  });
});
