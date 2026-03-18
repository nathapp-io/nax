/**
 * Tests for buildTargetStorySection.
 *
 * Verifies that the section includes all required story fields and a decompose instruction.
 */

import { describe, test, expect } from "bun:test";
import { buildTargetStorySection } from "../../../../src/decompose/sections/target-story";
import type { UserStory } from "../../../../src/prd";

function makeStory(overrides: Partial<UserStory> = {}): UserStory {
  return {
    id: "SD-042",
    title: "My feature story",
    description: "Implements the feature",
    acceptanceCriteria: ["Users can log in", "Session persists across pages"],
    tags: ["auth", "security"],
    dependencies: ["SD-001", "SD-002"],
    status: "pending",
    passes: false,
    escalations: [],
    attempts: 0,
    ...overrides,
  };
}

describe("buildTargetStorySection()", () => {
  test("includes the story ID", () => {
    const section = buildTargetStorySection(makeStory());
    expect(section).toContain("SD-042");
  });

  test("includes the story title", () => {
    const section = buildTargetStorySection(makeStory());
    expect(section).toContain("My feature story");
  });

  test("includes the story description", () => {
    const section = buildTargetStorySection(makeStory());
    expect(section).toContain("Implements the feature");
  });

  test("includes each acceptance criterion", () => {
    const section = buildTargetStorySection(makeStory());
    expect(section).toContain("Users can log in");
    expect(section).toContain("Session persists across pages");
  });

  test("includes each tag", () => {
    const section = buildTargetStorySection(makeStory());
    expect(section).toContain("auth");
    expect(section).toContain("security");
  });

  test("includes each dependency", () => {
    const section = buildTargetStorySection(makeStory());
    expect(section).toContain("SD-001");
    expect(section).toContain("SD-002");
  });

  test("includes a decompose instruction", () => {
    const section = buildTargetStorySection(makeStory());
    expect(section.toLowerCase()).toContain("decompose");
  });

  test("works with a single acceptance criterion", () => {
    const section = buildTargetStorySection(makeStory({ acceptanceCriteria: ["Single criterion"] }));
    expect(section).toContain("Single criterion");
  });

  test("different stories produce different sections", () => {
    const s1 = buildTargetStorySection(makeStory({ id: "SD-001", title: "First" }));
    const s2 = buildTargetStorySection(makeStory({ id: "SD-002", title: "Second" }));
    expect(s1).not.toBe(s2);
  });
});
