/**
 * Unit tests for git utility functions (TC-003)
 *
 * Covers: detectMergeConflict helper
 */

import { describe, expect, test } from "bun:test";
import { detectMergeConflict } from "../../../src/utils/git";

describe("detectMergeConflict", () => {
  test("returns true when output contains uppercase CONFLICT", () => {
    expect(detectMergeConflict("CONFLICT (content): Merge conflict in src/foo.ts")).toBe(true);
  });

  test("returns true when output contains lowercase conflict", () => {
    expect(detectMergeConflict("Auto-merging failed due to conflict in file")).toBe(true);
  });

  test("returns true for typical git merge CONFLICT output", () => {
    const output = [
      "Auto-merging src/index.ts",
      "CONFLICT (content): Merge conflict in src/index.ts",
      "Automatic merge failed; fix conflicts and then commit the result.",
    ].join("\n");
    expect(detectMergeConflict(output)).toBe(true);
  });

  test("returns true for git rebase CONFLICT output", () => {
    const output = "CONFLICT (modify/delete): src/bar.ts deleted in HEAD";
    expect(detectMergeConflict(output)).toBe(true);
  });

  test("returns false when output has no conflict markers", () => {
    expect(detectMergeConflict("All changes committed successfully.")).toBe(false);
  });

  test("returns false for empty string", () => {
    expect(detectMergeConflict("")).toBe(false);
  });

  test("returns false for unrelated git output", () => {
    const output = "3 files changed, 10 insertions(+), 2 deletions(-)";
    expect(detectMergeConflict(output)).toBe(false);
  });

  test("returns true when CONFLICT appears in stderr portion of combined output", () => {
    const combined = "stdout: commit abc123\nstderr: CONFLICT detected in merge";
    expect(detectMergeConflict(combined)).toBe(true);
  });
});
