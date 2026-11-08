// RE-ARCH: keep
/**
 * PRD failureCategory Tests
 *
 * Tests for failureCategory field on UserStory and the markStoryFailed()
 * function storing the category.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import type { FailureCategory } from "@/execution";
import { loadPRD, markStoryFailed, markStoryPassed, markStoryPaused } from "@/prd";
import type { PRD, UserStory } from "@/prd/types";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeStory(id: string): UserStory {
  return {
    id,
    title: `Story ${id}`,
    description: "Test story",
    acceptanceCriteria: ["AC1"],
    tags: [],
    dependencies: [],
    status: "pending",
    passes: false,
    escalations: [],
    attempts: 0,
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

// ── UserStory interface ───────────────────────────────────────────────────────

describe("UserStory.failureCategory field", () => {
  test("is optional — not present by default", () => {
    const story = makeStory("US-001");
    expect(story.failureCategory).toBeUndefined();
  });

  test("can be assigned a FailureCategory value", () => {
    const story = makeStory("US-001");
    story.failureCategory = "dependency-prep";
    expect(story.failureCategory).toBe("dependency-prep");
  });
});

// ── markStoryFailed() ─────────────────────────────────────────────────────────

describe("markStoryFailed()", () => {
  test("marks story as failed (backward compat — no failureCategory)", () => {
    const prd = makePrd([makeStory("US-001")]);
    markStoryFailed(prd, "US-001");
    expect(prd.userStories[0].status).toBe("failed");
    expect(prd.userStories[0].failureCategory).toBeUndefined();
  });

  test("increments attempts when no failureCategory given", () => {
    const prd = makePrd([makeStory("US-001")]);
    markStoryFailed(prd, "US-001");
    expect(prd.userStories[0].attempts).toBe(1);
  });

  // AC-10 and AC-11: the one category the registry still holds is recorded
  // together with the stage that produced it.
  test("AC-10/AC-11: stores failureCategory='dependency-prep' and failureStage='worktree-dependencies'", () => {
    const prd = makePrd([makeStory("US-001")]);
    markStoryFailed(prd, "US-001", "dependency-prep", "worktree-dependencies");
    expect(prd.userStories[0].failureCategory).toBe("dependency-prep");
    expect(prd.userStories[0].failureStage).toBe("worktree-dependencies");
    expect(prd.userStories[0].status).toBe("failed");
  });

  // AC-1 (pipeline-story-ops-delete US-004): FailureCategory's canonical owner
  // moves to src/execution/types. The retarget must not change
  // markStoryFailed's transition, so this pins the whole state change —
  // status, passes, attempts and category — in one place from a pending story
  // at attempts 0.
  test("marks a pending story failed with dependency-prep, attempts 1 and passes false", () => {
    const prd = makePrd([makeStory("US-001")]);
    expect(prd.userStories[0].status).toBe("pending");
    expect(prd.userStories[0].attempts).toBe(0);

    markStoryFailed(prd, "US-001", "dependency-prep");

    expect(prd.userStories[0].status).toBe("failed");
    expect(prd.userStories[0].passes).toBe(false);
    expect(prd.userStories[0].attempts).toBe(1);
    expect(prd.userStories[0].failureCategory).toBe("dependency-prep");
  });

  test("increments attempts when failureCategory is given", () => {
    const prd = makePrd([makeStory("US-001")]);
    prd.userStories[0].attempts = 2;
    markStoryFailed(prd, "US-001", "dependency-prep");
    expect(prd.userStories[0].attempts).toBe(3);
  });

  test("does not overwrite failureCategory with undefined when not passed", () => {
    const prd = makePrd([makeStory("US-001")]);
    // Simulate a prior failure that set a category
    prd.userStories[0].failureCategory = "dependency-prep";
    // Call without a category — should NOT clear the existing value
    markStoryFailed(prd, "US-001");
    expect(prd.userStories[0].failureCategory).toBe("dependency-prep");
  });

  test("does nothing when story not found", () => {
    const prd = makePrd([makeStory("US-001")]);
    // Should not throw
    markStoryFailed(prd, "US-999", "dependency-prep");
    expect(prd.userStories[0].status).toBe("pending");
  });

  // `passes` is a separate field from `status`, and dependency resolution reads
  // `passes` (story-selector.ts / story-context.ts) rather than `status`. A
  // story can genuinely go passed -> failed: unified-executor.ts marks a story
  // failed on merge conflict after its pipeline passed. If `passes` is left
  // true, dependents treat the failure as satisfied and run anyway.
  test("clears passes when a previously-passed story fails", () => {
    const prd = makePrd([makeStory("US-001")]);
    markStoryPassed(prd, "US-001");
    expect(prd.userStories[0].passes).toBe(true);

    markStoryFailed(prd, "US-001", "dependency-prep");

    expect(prd.userStories[0].status).toBe("failed");
    expect(prd.userStories[0].passes).toBe(false);
  });

  test("does not affect other stories", () => {
    const prd = makePrd([makeStory("US-001"), makeStory("US-002")]);
    markStoryFailed(prd, "US-001", "dependency-prep");
    expect(prd.userStories[1].status).toBe("pending");
    expect(prd.userStories[1].failureCategory).toBeUndefined();
  });
});

// ── FailureCategory type export from src/execution ───────────────────────────

describe("FailureCategory export from src/execution", () => {
  test("FailureCategory is exported from src/execution index", () => {
    // This test verifies the re-export compiles and can be used as a type
    const cat: FailureCategory = "dependency-prep";
    expect(cat).toBe("dependency-prep");
  });
});

// ── markStoryPaused / markStoryPassed unaffected ─────────────────────────────

describe("markStoryPaused and markStoryPassed — failureCategory not affected", () => {
  test.each([
    ["Paused" as const, (prd: PRD) => markStoryPaused(prd, "US-001"), "paused" as const],
    ["Passed" as const, (prd: PRD) => markStoryPassed(prd, "US-001"), "passed" as const],
  ])("markStory%s does not set failureCategory", (_label, fn, expectedStatus) => {
    const prd = makePrd([makeStory("US-001")]);
    fn(prd);
    expect(prd.userStories[0].status).toBe(expectedStatus);
    expect(prd.userStories[0].failureCategory).toBeUndefined();
  });
});

// ── nax#1582: markStoryPaused persists the blocking reason ───────────────────

describe("markStoryPaused — reason persistence (nax#1582)", () => {
  test("appends a PAUSED: entry to priorErrors when reason is given", () => {
    const prd = makePrd([makeStory("US-001")]);
    markStoryPaused(prd, "US-001", "Semantic review failed: 1 findings");
    expect(prd.userStories[0].priorErrors).toEqual(["PAUSED: Semantic review failed: 1 findings"]);
  });

  test("leaves priorErrors untouched when no reason is given", () => {
    const prd = makePrd([makeStory("US-001")]);
    markStoryPaused(prd, "US-001");
    expect(prd.userStories[0].priorErrors ?? []).toHaveLength(0);
  });

  test("appends to existing priorErrors rather than replacing them", () => {
    const prd = makePrd([makeStory("US-001")]);
    prd.userStories[0].priorErrors = ["Attempt 1 failed with model tier: fast"];
    markStoryPaused(prd, "US-001", "Rectification exhausted");
    expect(prd.userStories[0].priorErrors).toEqual([
      "Attempt 1 failed with model tier: fast",
      "PAUSED: Rectification exhausted",
    ]);
  });
});

// ── AC-12: a prd.json written by an older run keeps the category it recorded ──

describe("loadPRD — a historical failureCategory survives the load", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-prd-failure-category-");
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  test("AC-12: loads a story whose recorded category is no longer in the registry", async () => {
    const prdPath = join(tempDir, "prd.json");
    // A prd.json written by an older run: the registry no longer holds this
    // value, but the artifact keeps it verbatim.
    const historical = {
      project: "test",
      feature: "test-feature",
      branchName: "feature/test",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userStories: [{ ...makeStory("US-001"), failureCategory: "verifier-rejected" }],
    };
    await Bun.write(prdPath, JSON.stringify(historical));

    const loaded = await loadPRD(prdPath);

    const story = loaded.userStories.find((s) => s.id === "US-001");
    const category: string | undefined = story?.failureCategory;
    expect(category).toBe("verifier-rejected");
  });
});
