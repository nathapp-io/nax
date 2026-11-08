// RE-ARCH: keep
/**
 * PRD failureCategory Tests
 *
 * `failureCategory` is legacy metadata on `UserStory`: no current run writes it
 * (markStoryFailed records only a failure stage), but a prd.json written by an
 * older run may carry it and loadPRD keeps the recorded string verbatim.
 *
 * Tests for the field, for markStoryFailed's stage-only third parameter, and for
 * the historical value surviving a load.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
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

  test("holds the plain string an older run recorded", () => {
    const story = makeStory("US-001");
    story.failureCategory = "dependency-prep";
    expect(story.failureCategory).toBe("dependency-prep");
  });
});

// ── markStoryFailed() ─────────────────────────────────────────────────────────

describe("markStoryFailed()", () => {
  test("AC-1: sets that story's status to failed", () => {
    const prd = makePrd([makeStory("US-001")]);
    markStoryFailed(prd, "US-001", "review");
    expect(prd.userStories[0].status).toBe("failed");
  });

  // AC-2 pins WHERE the third positional argument lands. Before the category
  // parameter was removed it was stored as failureCategory, which left the
  // stage unset.
  test("AC-2: sets that story's failureStage to review", () => {
    const prd = makePrd([makeStory("US-001")]);
    markStoryFailed(prd, "US-001", "review");
    expect(prd.userStories[0].failureStage).toBe("review");
  });

  // AC-3 pins that the third argument is no longer recorded as a category.
  test("AC-3: leaves failureCategory undefined on a story with no recorded category", () => {
    const prd = makePrd([makeStory("US-001")]);
    markStoryFailed(prd, "US-001", "review");
    expect(prd.userStories[0].failureCategory).toBeUndefined();
  });

  // AC-5: the missing-story no-op survives the retarget — a failureStage must
  // not conjure a story, nor leave any other field touched.
  test("AC-5: leaves the PRD unchanged when no story has id US-999", () => {
    const prd = makePrd([makeStory("US-001")]);
    const before = structuredClone(prd);

    markStoryFailed(prd, "US-999", "review");

    expect(prd).toEqual(before);
    expect(prd.userStories[0].status).toBe("pending");
    expect(prd.userStories[0].attempts).toBe(0);
    expect(prd.userStories[0].failureStage).toBeUndefined();
  });

  test("increments attempts", () => {
    const prd = makePrd([makeStory("US-001")]);
    prd.userStories[0].attempts = 2;
    markStoryFailed(prd, "US-001", "review");
    expect(prd.userStories[0].attempts).toBe(3);
  });

  // The legacy field is not cleared: a failure says nothing about what an older
  // run recorded, so the recorded string survives.
  test("leaves a legacy recorded failureCategory untouched", () => {
    const prd = makePrd([makeStory("US-001")]);
    prd.userStories[0].failureCategory = "dependency-prep";
    markStoryFailed(prd, "US-001", "review");
    expect(prd.userStories[0].failureCategory).toBe("dependency-prep");
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

    markStoryFailed(prd, "US-001", "review");

    expect(prd.userStories[0].status).toBe("failed");
    expect(prd.userStories[0].passes).toBe(false);
  });

  test("does not affect other stories", () => {
    const prd = makePrd([makeStory("US-001"), makeStory("US-002")]);
    markStoryFailed(prd, "US-001", "review");
    expect(prd.userStories[1].status).toBe("pending");
    expect(prd.userStories[1].failureStage).toBeUndefined();
    expect(prd.userStories[1].failureCategory).toBeUndefined();
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

// ── AC-4: a prd.json written by an older run keeps the category it recorded ──

describe("loadPRD — a historical failureCategory survives the load", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-prd-failure-category-");
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  // AC-4: `dependency-prep` is data an older run wrote. No type in src/ names it
  // any more, and the load must not strip or reject it.
  test('AC-4: resolves with the story\'s failureCategory equal to "dependency-prep"', async () => {
    const prdPath = join(tempDir, "prd.json");
    const historical = {
      project: "test",
      feature: "test-feature",
      branchName: "feature/test",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userStories: [{ ...makeStory("US-001"), failureCategory: "dependency-prep" }],
    };
    await Bun.write(prdPath, JSON.stringify(historical));

    const loaded = await loadPRD(prdPath);

    const story = loaded.userStories.find((s) => s.id === "US-001");
    expect(story?.failureCategory).toBe("dependency-prep");
  });
});
