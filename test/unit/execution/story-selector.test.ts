/**
 * Tests for story-selector module (US-002)
 *
 * Tests selectIndependentBatch() and groupStoriesByDependencies() functions
 */

import { describe, test, expect } from "bun:test";
import { selectIndependentBatch, groupStoriesByDependencies } from "../../../src/execution/story-selector";
import type { UserStory } from "../../../src/prd/types";

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

/**
 * Helper to create a completed story (passes or status='passed')
 */
function createCompletedStory(id: string, dependencies: string[] = []): UserStory {
  return {
    ...createStory(id, dependencies),
    status: "passed",
    passes: true,
  };
}

describe.skip("selectIndependentBatch", () => {
  test("returns an empty array when stories is empty", () => {
    const result = selectIndependentBatch([], 10);
    expect(result).toEqual([]);
  });

  test("returns a single-element array when exactly one story has no unmet dependencies", () => {
    const stories = [createStory("US-001", [])];
    const result = selectIndependentBatch(stories, 10);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("US-001");
  });

  test("returns at most maxCount stories even when more dependency-free stories are available", () => {
    const stories = [
      createStory("US-001", []),
      createStory("US-002", []),
      createStory("US-003", []),
      createStory("US-004", []),
    ];
    const result = selectIndependentBatch(stories, 2);
    expect(result).toHaveLength(2);
  });

  test("returns only stories whose dependencies are all in status 'passed'", () => {
    const completed1 = createCompletedStory("US-001");
    const completed2 = createCompletedStory("US-002");
    const pending = createStory("US-003", ["US-001", "US-002"]);
    const withUnmetDep = createStory("US-004", ["US-001", "US-005"]);
    const noDep = createStory("US-005", []);

    const stories = [completed1, completed2, pending, withUnmetDep, noDep];
    const result = selectIndependentBatch(stories, 10);

    // Should include: US-003 (deps all passed), US-005 (no deps)
    // Should not include: completed stories (passes=true), withUnmetDep (US-005 not passed)
    expect(result).toHaveLength(2);
    expect(result.map((s) => s.id).sort()).toEqual(["US-003", "US-005"]);
  });

  test("skips stories that already passed", () => {
    const passed = createCompletedStory("US-001");
    const pending = createStory("US-002", []);

    const stories = [passed, pending];
    const result = selectIndependentBatch(stories, 10);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("US-002");
  });

  test("skips stories with skipped status", () => {
    const skipped: UserStory = { ...createStory("US-001"), status: "skipped" };
    const pending = createStory("US-002", []);

    const stories = [skipped, pending];
    const result = selectIndependentBatch(stories, 10);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("US-002");
  });

  test("respects dependency order - returns only stories in first independent batch", () => {
    const s1 = createStory("US-001", []);
    const s2 = createStory("US-002", ["US-001"]);
    const s3 = createStory("US-003", []);

    // Mark US-001 as completed
    s1.status = "passed";
    s1.passes = true;

    const stories = [s1, s2, s3];
    const result = selectIndependentBatch(stories, 10);

    // Should return US-002 and US-003 (both have all deps completed)
    expect(result).toHaveLength(2);
    expect(result.map((s) => s.id).sort()).toEqual(["US-002", "US-003"]);
  });

  test("respects maxCount limit with multiple independent stories", () => {
    const stories = Array.from({ length: 5 }, (_, i) => createStory(`US-${i + 1}`, []));

    const result = selectIndependentBatch(stories, 3);
    expect(result).toHaveLength(3);
  });

  test("handles stories with passes=true flag", () => {
    const s1: UserStory = { ...createStory("US-001"), passes: true };
    const s2 = createStory("US-002", ["US-001"]);

    const stories = [s1, s2];
    const result = selectIndependentBatch(stories, 10);

    // US-001 has passes=true so should be skipped
    // US-002 should be included because US-001.passes=true means dependency is met
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("US-002");
  });
});

describe.skip("groupStoriesByDependencies", () => {
  test("returns single batch for stories with no dependencies", () => {
    const stories = [
      createStory("US-001", []),
      createStory("US-002", []),
      createStory("US-003", []),
    ];

    const batches = groupStoriesByDependencies(stories);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(3);
  });

  test("groups stories into dependency-ordered batches", () => {
    const stories = [
      createStory("US-001", []),
      createStory("US-002", ["US-001"]),
      createStory("US-003", ["US-002"]),
    ];

    const batches = groupStoriesByDependencies(stories);
    expect(batches).toHaveLength(3);
    expect(batches[0].map((s) => s.id)).toEqual(["US-001"]);
    expect(batches[1].map((s) => s.id)).toEqual(["US-002"]);
    expect(batches[2].map((s) => s.id)).toEqual(["US-003"]);
  });

  test("groups parallel-ready stories in same batch", () => {
    const stories = [
      createStory("US-001", []),
      createStory("US-002", ["US-001"]),
      createStory("US-003", ["US-001"]),
    ];

    const batches = groupStoriesByDependencies(stories);
    expect(batches).toHaveLength(2);
    expect(batches[0].map((s) => s.id)).toEqual(["US-001"]);
    expect(batches[1].map((s) => s.id).sort()).toEqual(["US-002", "US-003"]);
  });

  test("handles single story", () => {
    const stories = [createStory("US-001", [])];
    const batches = groupStoriesByDependencies(stories);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
  });

  test("throws error on circular dependency", () => {
    const stories = [
      createStory("US-001", ["US-002"]),
      createStory("US-002", ["US-001"]),
    ];

    expect(() => groupStoriesByDependencies(stories)).toThrow("Circular dependency or missing dependency detected");
  });

  test("handles external dependencies (dependencies not in story list)", () => {
    const stories = [
      createStory("US-001", ["EXTERNAL-DEP"]),
      createStory("US-002", ["US-001"]),
    ];

    const batches = groupStoriesByDependencies(stories);
    expect(batches).toHaveLength(2);
    expect(batches[0].map((s) => s.id)).toEqual(["US-001"]);
    expect(batches[1].map((s) => s.id)).toEqual(["US-002"]);
  });
});
