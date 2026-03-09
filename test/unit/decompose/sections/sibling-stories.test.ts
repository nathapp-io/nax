/**
 * Tests for buildSiblingStoriesSection.
 *
 * Verifies that the section lists all PRD stories EXCEPT the target story,
 * and includes id, title, status, and AC summary for each.
 */

import { describe, test, expect } from "bun:test";
import { buildSiblingStoriesSection } from "../../../../src/decompose/sections/sibling-stories";
import type { UserStory, PRD } from "../../../../src/prd";

function makeStory(id: string, overrides: Partial<UserStory> = {}): UserStory {
  return {
    id,
    title: `Story ${id}`,
    description: `Description for ${id}`,
    acceptanceCriteria: [`${id} criterion one`, `${id} criterion two`],
    tags: ["tag-a"],
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
    project: "nax",
    feature: "story-decompose",
    branchName: "feat/story-decompose",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    userStories: stories,
  };
}

describe("buildSiblingStoriesSection()", () => {
  test("returns a non-empty string when siblings exist", () => {
    const target = makeStory("SD-001");
    const sibling = makeStory("SD-002");
    const prd = makePrd([target, sibling]);
    const section = buildSiblingStoriesSection(target, prd);
    expect(typeof section).toBe("string");
    expect(section.length).toBeGreaterThan(0);
  });

  test("includes sibling story ID", () => {
    const target = makeStory("SD-001");
    const sibling = makeStory("SD-002");
    const section = buildSiblingStoriesSection(target, makePrd([target, sibling]));
    expect(section).toContain("SD-002");
  });

  test("includes sibling story title", () => {
    const target = makeStory("SD-001");
    const sibling = makeStory("SD-002");
    const section = buildSiblingStoriesSection(target, makePrd([target, sibling]));
    expect(section).toContain("Story SD-002");
  });

  test("includes sibling story status", () => {
    const target = makeStory("SD-001");
    const sibling = makeStory("SD-002", { status: "passed" });
    const section = buildSiblingStoriesSection(target, makePrd([target, sibling]));
    expect(section).toContain("passed");
  });

  test("includes sibling story AC summary", () => {
    const target = makeStory("SD-001");
    const sibling = makeStory("SD-002");
    const section = buildSiblingStoriesSection(target, makePrd([target, sibling]));
    expect(section).toContain("SD-002 criterion one");
  });

  test("does NOT include the target story ID in the listing", () => {
    const target = makeStory("SD-001");
    const sibling = makeStory("SD-002");
    const section = buildSiblingStoriesSection(target, makePrd([target, sibling]));
    // SD-001 must not be listed as a sibling
    expect(section).not.toContain("SD-001");
  });

  test("includes all multiple siblings", () => {
    const target = makeStory("SD-001");
    const s2 = makeStory("SD-002");
    const s3 = makeStory("SD-003", { status: "in-progress" });
    const s4 = makeStory("SD-004", { status: "failed" });
    const section = buildSiblingStoriesSection(target, makePrd([target, s2, s3, s4]));
    expect(section).toContain("SD-002");
    expect(section).toContain("SD-003");
    expect(section).toContain("SD-004");
  });

  test("includes different statuses for multiple siblings", () => {
    const target = makeStory("SD-001");
    const s2 = makeStory("SD-002", { status: "in-progress" });
    const s3 = makeStory("SD-003", { status: "skipped" });
    const section = buildSiblingStoriesSection(target, makePrd([target, s2, s3]));
    expect(section).toContain("in-progress");
    expect(section).toContain("skipped");
  });

  test("returns string when no siblings exist (only target in PRD)", () => {
    const target = makeStory("SD-001");
    const section = buildSiblingStoriesSection(target, makePrd([target]));
    // Should not throw; result is a string (even if empty or placeholder)
    expect(typeof section).toBe("string");
    // Target story should not appear as a sibling
    expect(section).not.toContain("Story SD-001");
  });

  test("different target stories produce different sections", () => {
    const t1 = makeStory("SD-001");
    const t2 = makeStory("SD-002");
    const s3 = makeStory("SD-003");
    const prd1 = makePrd([t1, t2, s3]);
    const prd2 = makePrd([t1, t2, s3]);

    const sec1 = buildSiblingStoriesSection(t1, prd1);
    const sec2 = buildSiblingStoriesSection(t2, prd2);
    // sec1 lists SD-002 and SD-003 as siblings; sec2 lists SD-001 and SD-003
    expect(sec1).not.toBe(sec2);
  });
});
