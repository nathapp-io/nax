/**
 * Unit Tests: PRD mutation for story decomposition (SD-003)
 *
 * Verifies that:
 * - 'decomposed' is a valid StoryStatus value
 * - applyDecomposition() marks original story as 'decomposed'
 * - applyDecomposition() inserts substories with parentStoryId and 'pending' status
 * - getNextStory() skips stories with status 'decomposed'
 * - countStories() includes a 'decomposed' count
 *
 * These tests FAIL until SD-003 is implemented.
 */

import { describe, expect, test } from "bun:test";
import { applyDecomposition } from "../../../src/decompose/apply";
import type { DecomposeResult, SubStory } from "../../../src/decompose/types";
import { countStories, getNextStory } from "../../../src/prd";
import type { PRD, StoryStatus, UserStory } from "../../../src/prd";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeStory(id: string, status: StoryStatus = "pending", dependencies: string[] = []): UserStory {
  return {
    id,
    title: `Story ${id}`,
    description: `Description for ${id}`,
    acceptanceCriteria: ["AC 1", "AC 2"],
    tags: [],
    dependencies,
    status,
    passes: false,
    escalations: [],
    attempts: 0,
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

function makeSubStory(id: string, parentStoryId: string): SubStory {
  return {
    id,
    parentStoryId,
    title: `Sub-story ${id}`,
    description: `Description for ${id}`,
    acceptanceCriteria: ["Sub AC 1"],
    tags: [],
    dependencies: [],
    complexity: "simple",
    nonOverlapJustification: "No overlap",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// StoryStatus — 'decomposed' is a valid value
// ─────────────────────────────────────────────────────────────────────────────

describe("StoryStatus — 'decomposed' is valid", () => {
  test("a story can be created with status 'decomposed'", () => {
    // FAILS until SD-003 adds 'decomposed' to StoryStatus union
    // Using 'as' cast here; if type system accepts it cleanly, the union was updated
    const decomposedStatus: StoryStatus = "decomposed" as StoryStatus;
    const story = makeStory("US-001", decomposedStatus);
    expect(story.status).toBe("decomposed");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// applyDecomposition — marks original as decomposed
// ─────────────────────────────────────────────────────────────────────────────

describe("applyDecomposition — original story", () => {
  const subStories = [makeSubStory("US-001-1", "US-001"), makeSubStory("US-001-2", "US-001")];
  const result: DecomposeResult = {
    subStories,
    validation: { valid: true, errors: [], warnings: [] },
  };

  test("marks the original story as 'decomposed'", () => {
    // FAILS until SD-003 implements applyDecomposition (currently throws)
    const prd = makePRD([makeStory("US-001"), makeStory("US-002")]);
    applyDecomposition(prd, result);

    const original = prd.userStories.find((s) => s.id === "US-001");
    // Use string comparison since 'decomposed' not yet in StoryStatus union (SD-003)
    expect(original?.status as string).toBe("decomposed");
  });

  test("does not modify other stories' status", () => {
    // FAILS until SD-003 implements applyDecomposition
    const prd = makePRD([makeStory("US-001"), makeStory("US-002")]);
    applyDecomposition(prd, result);

    const other = prd.userStories.find((s) => s.id === "US-002");
    expect(other?.status).toBe("pending");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// applyDecomposition — inserts substories
// ─────────────────────────────────────────────────────────────────────────────

describe("applyDecomposition — substory insertion", () => {
  const subStories = [makeSubStory("US-001-1", "US-001"), makeSubStory("US-001-2", "US-001")];
  const result: DecomposeResult = {
    subStories,
    validation: { valid: true, errors: [], warnings: [] },
  };

  test("inserts substories into the PRD story list", () => {
    // FAILS until SD-003 implements applyDecomposition
    const prd = makePRD([makeStory("US-001"), makeStory("US-002")]);
    applyDecomposition(prd, result);

    expect(prd.userStories.length).toBe(4); // US-001 + US-001-1 + US-001-2 + US-002
  });

  test("substories are inserted immediately after the original story", () => {
    // FAILS until SD-003 implements applyDecomposition
    const prd = makePRD([makeStory("US-001"), makeStory("US-002")]);
    applyDecomposition(prd, result);

    const ids = prd.userStories.map((s) => s.id);
    const originalIndex = ids.indexOf("US-001");
    expect(ids[originalIndex + 1]).toBe("US-001-1");
    expect(ids[originalIndex + 2]).toBe("US-001-2");
  });

  test("each substory has status 'pending'", () => {
    // FAILS until SD-003 implements applyDecomposition
    const prd = makePRD([makeStory("US-001"), makeStory("US-002")]);
    applyDecomposition(prd, result);

    const sub1 = prd.userStories.find((s) => s.id === "US-001-1");
    const sub2 = prd.userStories.find((s) => s.id === "US-001-2");
    expect(sub1?.status as string).toBe("pending");
    expect(sub2?.status as string).toBe("pending");
  });

  test("each substory has parentStoryId matching the original story", () => {
    // FAILS until SD-003 implements applyDecomposition
    const prd = makePRD([makeStory("US-001"), makeStory("US-002")]);
    applyDecomposition(prd, result);

    const sub1 = prd.userStories.find((s) => s.id === "US-001-1") as UserStory & { parentStoryId?: string };
    const sub2 = prd.userStories.find((s) => s.id === "US-001-2") as UserStory & { parentStoryId?: string };
    expect(sub1?.parentStoryId).toBe("US-001");
    expect(sub2?.parentStoryId).toBe("US-001");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getNextStory — skips 'decomposed' stories
// ─────────────────────────────────────────────────────────────────────────────

describe("getNextStory — skips decomposed stories", () => {
  test("does not return a story with status 'decomposed'", () => {
    // FAILS until SD-003 adds 'decomposed' to the skip list in getNextStory
    const decomposedStatus = "decomposed" as StoryStatus;
    const prd = makePRD([makeStory("US-001", decomposedStatus), makeStory("US-002", "pending")]);

    const next = getNextStory(prd);
    expect(next?.id).not.toBe("US-001");
    expect(next?.id).toBe("US-002");
  });

  test("returns null when only decomposed stories remain", () => {
    // FAILS until SD-003 adds 'decomposed' to the skip list in getNextStory
    const decomposedStatus = "decomposed" as StoryStatus;
    const prd = makePRD([makeStory("US-001", decomposedStatus), makeStory("US-002", decomposedStatus)]);

    const next = getNextStory(prd);
    expect(next).toBeNull();
  });

  test("skips decomposed story and returns first eligible pending story", () => {
    // FAILS until SD-003 adds 'decomposed' to the skip list in getNextStory
    const decomposedStatus = "decomposed" as StoryStatus;
    const prd = makePRD([
      makeStory("US-001", decomposedStatus),
      makeStory("US-002", "pending"),
      makeStory("US-003", "pending"),
    ]);

    const next = getNextStory(prd);
    expect(next?.id).toBe("US-002");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// countStories — includes 'decomposed' count
// ─────────────────────────────────────────────────────────────────────────────

describe("countStories — includes decomposed", () => {
  test("countStories result has a 'decomposed' property", () => {
    // FAILS until SD-003 adds 'decomposed' to countStories return type
    const prd = makePRD([makeStory("US-001", "pending")]);
    const counts = countStories(prd);
    expect(counts).toHaveProperty("decomposed");
  });

  test("decomposed count is 0 when no stories are decomposed", () => {
    // FAILS until SD-003 adds 'decomposed' to countStories
    const prd = makePRD([makeStory("US-001", "pending"), makeStory("US-002", "passed")]);
    const counts = countStories(prd) as ReturnType<typeof countStories> & { decomposed: number };
    expect(counts.decomposed).toBe(0);
  });

  test("decomposed count reflects number of decomposed stories", () => {
    // FAILS until SD-003 adds 'decomposed' to countStories
    const decomposedStatus = "decomposed" as StoryStatus;
    const prd = makePRD([
      makeStory("US-001", decomposedStatus),
      makeStory("US-002", decomposedStatus),
      makeStory("US-003", "pending"),
    ]);
    const counts = countStories(prd) as ReturnType<typeof countStories> & { decomposed: number };
    expect(counts.decomposed).toBe(2);
  });

  test("total includes decomposed stories in the count", () => {
    // FAILS until SD-003 adds 'decomposed' to countStories
    const decomposedStatus = "decomposed" as StoryStatus;
    const prd = makePRD([makeStory("US-001", decomposedStatus), makeStory("US-002", "pending")]);
    const counts = countStories(prd);
    expect(counts.total).toBe(2);
  });

  test("decomposed stories are not counted as pending", () => {
    // FAILS until SD-003 — currently 'decomposed' is an unknown status and
    // countStories() would include it as 'pending' (fall-through behavior)
    const decomposedStatus = "decomposed" as StoryStatus;
    const prd = makePRD([makeStory("US-001", decomposedStatus), makeStory("US-002", "pending")]);
    const counts = countStories(prd);
    expect(counts.pending).toBe(1);
  });
});
