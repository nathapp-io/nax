import { describe, expect, test } from "bun:test";
import type { UserStory } from "../../../../src/prd/types";
import { buildBatchStorySection, buildStorySection } from "../../../../src/prompts/sections/story";

function makeStory(overrides: Partial<UserStory> = {}): UserStory {
  return {
    id: "STORY-001",
    title: "Test Story",
    description: "This is a test story",
    acceptanceCriteria: ["Criterion 1", "Criterion 2", "Criterion 3"],
    status: "pending",
    passes: false,
    dependencies: [],
    tags: [],
    escalations: [],
    attempts: 0,
    ...overrides,
  };
}

describe("buildStorySection", () => {
  const mockStory = makeStory();

  test("includes story title", () => {
    const result = buildStorySection(mockStory);
    expect(result).toContain("Test Story");
  });

  test("includes story description", () => {
    const result = buildStorySection(mockStory);
    expect(result).toContain("This is a test story");
  });

  test("includes numbered acceptance criteria", () => {
    const result = buildStorySection(mockStory);
    expect(result).toContain("1. Criterion 1");
    expect(result).toContain("2. Criterion 2");
    expect(result).toContain("3. Criterion 3");
  });

  test("returns non-empty string", () => {
    const result = buildStorySection(mockStory);
    expect(result.length).toBeGreaterThan(0);
  });

  test("formats criteria with numeric prefixes", () => {
    const result = buildStorySection(mockStory);
    const lines = result.split("\n");
    const criteriaLines = lines.filter((l) => /^\d+\./.test(l.trim()));
    expect(criteriaLines.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// BP-001: buildBatchStorySection tests (RED phase — will fail until implemented)
// ---------------------------------------------------------------------------

describe("buildBatchStorySection", () => {
  const storyA = makeStory({
    id: "BP-001",
    title: "First Batch Story",
    description: "Description for first story",
    acceptanceCriteria: ["AC 1a", "AC 1b"],
  });

  const storyB = makeStory({
    id: "BP-002",
    title: "Second Batch Story",
    description: "Description for second story",
    acceptanceCriteria: ["AC 2a"],
  });

  test("returns non-empty string for a single story", () => {
    const result = buildBatchStorySection([storyA]);
    expect(result.length).toBeGreaterThan(0);
  });

  test("returns non-empty string for multiple stories", () => {
    const result = buildBatchStorySection([storyA, storyB]);
    expect(result.length).toBeGreaterThan(0);
  });

  test("includes USER-SUPPLIED DATA opening boundary tag", () => {
    const result = buildBatchStorySection([storyA]);
    expect(result).toContain("<!-- USER-SUPPLIED DATA:");
  });

  test("includes END USER-SUPPLIED DATA closing boundary tag", () => {
    const result = buildBatchStorySection([storyA]);
    expect(result).toContain("<!-- END USER-SUPPLIED DATA -->");
  });

  test("formats each story heading as '## Story N: {id} - {title}'", () => {
    const result = buildBatchStorySection([storyA, storyB]);
    expect(result).toContain("## Story 1: BP-001 - First Batch Story");
    expect(result).toContain("## Story 2: BP-002 - Second Batch Story");
  });

  test("includes description for each story", () => {
    const result = buildBatchStorySection([storyA, storyB]);
    expect(result).toContain("Description for first story");
    expect(result).toContain("Description for second story");
  });

  test("includes numbered acceptance criteria for each story", () => {
    const result = buildBatchStorySection([storyA, storyB]);
    expect(result).toContain("1. AC 1a");
    expect(result).toContain("2. AC 1b");
    expect(result).toContain("1. AC 2a");
  });

  test("renders all story IDs in order", () => {
    const result = buildBatchStorySection([storyA, storyB]);
    const idxA = result.indexOf("BP-001");
    const idxB = result.indexOf("BP-002");
    expect(idxA).toBeGreaterThanOrEqual(0);
    expect(idxB).toBeGreaterThanOrEqual(0);
    expect(idxA).toBeLessThan(idxB);
  });

  test("single story uses heading '## Story 1: {id} - {title}'", () => {
    const result = buildBatchStorySection([storyA]);
    expect(result).toContain("## Story 1: BP-001 - First Batch Story");
  });
});
