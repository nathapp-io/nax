// RE-ARCH: keep
/**
 * Tests for asset verification with contextFiles/expectedFiles split
 */

import { describe, expect, test } from "bun:test";
import { getExpectedFiles } from "../../../src/prd";
import type { UserStory } from "../../../src/prd";

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

describe("Asset verification behavior", () => {
  test("story with relevantFiles but no expectedFiles should skip asset check", () => {
    const story = createStory({
      relevantFiles: ["src/foo.ts", "src/bar.ts"],
    });

    const filesToVerify = getExpectedFiles(story);

    // Asset check is opt-in only - empty array means skip verification
    expect(filesToVerify).toEqual([]);
  });

  test("story with expectedFiles should verify those files", () => {
    const story = createStory({
      expectedFiles: ["dist/output.js", "dist/types.d.ts"],
    });

    const filesToVerify = getExpectedFiles(story);

    expect(filesToVerify).toEqual(["dist/output.js", "dist/types.d.ts"]);
  });

  test("story with both contextFiles and expectedFiles should only verify expectedFiles", () => {
    const story = createStory({
      contextFiles: ["src/input.ts", "src/helper.ts"],
      expectedFiles: ["dist/output.js"],
    });

    const filesToVerify = getExpectedFiles(story);

    // Only expectedFiles are verified, not contextFiles
    expect(filesToVerify).toEqual(["dist/output.js"]);
  });

  test("story with no files specified should skip asset check", () => {
    const story = createStory({});

    const filesToVerify = getExpectedFiles(story);

    expect(filesToVerify).toEqual([]);
  });

  test("story with empty expectedFiles array should skip asset check", () => {
    const story = createStory({
      expectedFiles: [],
    });

    const filesToVerify = getExpectedFiles(story);

    expect(filesToVerify).toEqual([]);
  });

  test("legacy story with relevantFiles for both context and verification", () => {
    // Old behavior: relevantFiles used for both context AND verification
    // New behavior: relevantFiles used ONLY for context fallback, NOT verification
    const legacyStory = createStory({
      relevantFiles: ["src/module.ts"],
    });

    const filesToVerify = getExpectedFiles(legacyStory);

    // CRITICAL: No automatic verification of relevantFiles
    // This prevents false negatives from LLM-hallucinated filenames
    expect(filesToVerify).toEqual([]);
  });

  test("migrated story with explicit expectedFiles for verification", () => {
    const migratedStory = createStory({
      contextFiles: ["src/module.ts"],
      expectedFiles: ["src/module.ts"], // Explicitly opt-in to verification
    });

    const filesToVerify = getExpectedFiles(migratedStory);

    expect(filesToVerify).toEqual(["src/module.ts"]);
  });
});

describe("Verification scenarios from dogfood runs", () => {
  test("Run F scenario: LLM predicts wrong filename but code is correct", () => {
    // Context: LLM predicted "src/cli/status.ts" but actual file was "src/cli/queue-status.ts"
    // Old behavior: Asset check fails even though code is correct
    // New behavior: Asset check is opt-in only
    const story = createStory({
      relevantFiles: ["src/cli/status.ts"], // LLM prediction (wrong)
      // No expectedFiles - asset check is opt-in
    });

    const filesToVerify = getExpectedFiles(story);

    // Asset check skipped - no false negative
    expect(filesToVerify).toEqual([]);
  });

  test("Run H scenario: explicit expectedFiles for critical output", () => {
    // Context: When output files MUST exist, explicitly set expectedFiles
    const story = createStory({
      contextFiles: ["src/input.ts"], // Context for agent
      expectedFiles: ["dist/bundle.js", "dist/bundle.css"], // Must exist
    });

    const filesToVerify = getExpectedFiles(story);

    // Asset check runs on explicitly specified files only
    expect(filesToVerify).toEqual(["dist/bundle.js", "dist/bundle.css"]);
  });

  test("common case: simple refactor with context but no asset requirement", () => {
    // Most stories: agent needs context but doesn't create new files
    const story = createStory({
      contextFiles: ["src/utils/formatter.ts", "src/types.ts"],
      // No expectedFiles - just modifying existing files
    });

    const filesToVerify = getExpectedFiles(story);

    // No asset check needed
    expect(filesToVerify).toEqual([]);
  });
});
