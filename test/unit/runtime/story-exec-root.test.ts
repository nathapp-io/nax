import { describe, expect, test } from "bun:test";
import { storyExecRoot } from "@/runtime/packages";

describe("storyExecRoot (nax#2093)", () => {
  test("returns the worktree root for a worktree-prefixed package", () => {
    expect(storyExecRoot({ repoRoot: "/repo", packageDir: ".nax-wt/US-003/packages/api" })).toBe(
      "/repo/.nax-wt/US-003",
    );
  });

  test("returns the worktree root for a worktree-prefixed ROOT package", () => {
    expect(storyExecRoot({ repoRoot: "/repo", packageDir: ".nax-wt/US-003" })).toBe("/repo/.nax-wt/US-003");
  });

  test("returns repoRoot when the story is not isolated", () => {
    expect(storyExecRoot({ repoRoot: "/repo", packageDir: "packages/api" })).toBe("/repo");
  });

  test("returns repoRoot when there is no packageDir", () => {
    expect(storyExecRoot({ repoRoot: "/repo" })).toBe("/repo");
  });

  test("does not treat a package literally named nax-wt as a worktree", () => {
    expect(storyExecRoot({ repoRoot: "/repo", packageDir: "nax-wt/pkg" })).toBe("/repo");
  });

  test("does not fall back to repoRoot for an absolute packageDir (nax#2093)", () => {
    // `packageWorkdir` defends this same field with `isAbsolute(packageDir)`
    // and returns the path unchanged. Without the mirrored guard,
    // `split("/")[0]` is "" for an absolute path, the `.nax-wt` check falls
    // through, and the function returns the MAIN CHECKOUT — silently
    // re-entering the very bug it exists to fix.
    const absolute = "/repo/.nax-wt/US-003/packages/api";
    const result = storyExecRoot({ repoRoot: "/repo", packageDir: absolute });
    expect(result).not.toBe("/repo");
    expect(result).toBe(absolute);
  });
});
