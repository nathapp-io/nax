import { expect, test } from "bun:test";
import { validateStoryId } from "@/prd";
import { deriveBakeoffWorktreeId, storyBranchName, type WorktreeId } from "@/worktree";

test("AC-1: storyBranchName returns a validateStoryId-compatible branch for representative WorktreeId inputs", () => {
  const worktreeIds: WorktreeId[] = ["US-001" as WorktreeId, deriveBakeoffWorktreeId("feature-x", "profile-y")];

  for (const worktreeId of worktreeIds) {
    expect(() => validateStoryId(storyBranchName(worktreeId))).not.toThrow();
  }
});