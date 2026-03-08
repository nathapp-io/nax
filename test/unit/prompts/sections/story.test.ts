import { describe, expect, test } from "bun:test";
import type { UserStory } from "../../../../src/prd/types";
import { buildStorySection } from "../../../../src/prompts/sections/story";

describe("buildStorySection", () => {
  const mockStory: UserStory = {
    id: "STORY-001",
    title: "Test Story",
    description: "This is a test story",
    acceptanceCriteria: ["Criterion 1", "Criterion 2", "Criterion 3"],
    status: "pending",
    passes: false,
    dependencies: [],
    tags: [],
  };

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
