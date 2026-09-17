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
});
