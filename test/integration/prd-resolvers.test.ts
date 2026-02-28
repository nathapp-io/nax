/**
 * Tests for PRD resolver functions: getContextFiles and getExpectedFiles
 */

import { describe, expect, test } from "bun:test";
import { getContextFiles, getExpectedFiles } from "../../src/prd";
import type { UserStory } from "../../src/prd";

const createStory = (partial: Partial<UserStory>): UserStory => ({
  id: "US-001",
  title: "Test Story",
  description: "Test description",
  acceptanceCriteria: ["AC1"],
  tags: [],
  dependencies: [],
  status: "pending",
  passes: false,
  escalations: [],
  attempts: 0,
  ...partial,
});

describe("getContextFiles", () => {
  test("should return contextFiles when present", () => {
    const story = createStory({
      contextFiles: ["src/foo.ts", "src/bar.ts"],
    });

    const result = getContextFiles(story);

    expect(result).toEqual(["src/foo.ts", "src/bar.ts"]);
  });

  test("should fall back to relevantFiles when contextFiles is undefined", () => {
    const story = createStory({
      relevantFiles: ["src/legacy.ts", "src/old.ts"],
    });

    const result = getContextFiles(story);

    expect(result).toEqual(["src/legacy.ts", "src/old.ts"]);
  });

  test("should prefer contextFiles over relevantFiles when both present", () => {
    const story = createStory({
      contextFiles: ["src/new.ts"],
      relevantFiles: ["src/old.ts"],
    });

    const result = getContextFiles(story);

    expect(result).toEqual(["src/new.ts"]);
  });

  test("should return empty array when neither contextFiles nor relevantFiles is set", () => {
    const story = createStory({});

    const result = getContextFiles(story);

    expect(result).toEqual([]);
  });

  test("should handle empty contextFiles array", () => {
    const story = createStory({
      contextFiles: [],
    });

    const result = getContextFiles(story);

    expect(result).toEqual([]);
  });

  test("should handle empty relevantFiles array", () => {
    const story = createStory({
      relevantFiles: [],
    });

    const result = getContextFiles(story);

    expect(result).toEqual([]);
  });
});

describe("getExpectedFiles", () => {
  test("should return expectedFiles when present", () => {
    const story = createStory({
      expectedFiles: ["dist/output.js", "build/app.js"],
    });

    const result = getExpectedFiles(story);

    expect(result).toEqual(["dist/output.js", "build/app.js"]);
  });

  test("should return empty array when expectedFiles is undefined", () => {
    const story = createStory({});

    const result = getExpectedFiles(story);

    expect(result).toEqual([]);
  });

  test("should NOT fall back to relevantFiles when expectedFiles is undefined", () => {
    const story = createStory({
      relevantFiles: ["src/foo.ts", "src/bar.ts"],
    });

    const result = getExpectedFiles(story);

    // CRITICAL: Asset check is opt-in only, no fallback to relevantFiles
    expect(result).toEqual([]);
  });

  test("should prefer expectedFiles over relevantFiles when both present", () => {
    const story = createStory({
      expectedFiles: ["dist/new.js"],
      relevantFiles: ["src/old.ts"],
    });

    const result = getExpectedFiles(story);

    expect(result).toEqual(["dist/new.js"]);
  });

  test("should handle empty expectedFiles array", () => {
    const story = createStory({
      expectedFiles: [],
    });

    const result = getExpectedFiles(story);

    expect(result).toEqual([]);
  });

  test("should allow contextFiles and expectedFiles to differ", () => {
    const story = createStory({
      contextFiles: ["src/input.ts", "src/helper.ts"],
      expectedFiles: ["dist/output.js"],
    });

    const contextResult = getContextFiles(story);
    const expectedResult = getExpectedFiles(story);

    expect(contextResult).toEqual(["src/input.ts", "src/helper.ts"]);
    expect(expectedResult).toEqual(["dist/output.js"]);
  });
});

describe("backward compatibility", () => {
  test("should support legacy stories with only relevantFiles for context", () => {
    const legacyStory = createStory({
      relevantFiles: ["src/legacy.ts"],
    });

    const contextFiles = getContextFiles(legacyStory);
    const expectedFiles = getExpectedFiles(legacyStory);

    // Context uses fallback
    expect(contextFiles).toEqual(["src/legacy.ts"]);
    // Asset check is opt-in, no fallback
    expect(expectedFiles).toEqual([]);
  });

  test("should support migration from relevantFiles to contextFiles", () => {
    const migratedStory = createStory({
      contextFiles: ["src/new.ts"],
      relevantFiles: ["src/old.ts"], // Kept for backward compat but unused
    });

    const contextFiles = getContextFiles(migratedStory);

    expect(contextFiles).toEqual(["src/new.ts"]);
  });

  test("should support explicit expectedFiles for asset verification", () => {
    const verifiedStory = createStory({
      contextFiles: ["src/input.ts"],
      expectedFiles: ["dist/output.js", "dist/types.d.ts"],
    });

    const expectedFiles = getExpectedFiles(verifiedStory);

    expect(expectedFiles).toEqual(["dist/output.js", "dist/types.d.ts"]);
  });
});
