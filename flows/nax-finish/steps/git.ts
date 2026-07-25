/**
 * Branch synchronisation for the nax-finish flow.
 *
 * Every fix node edits the working tree in place. Without this step those edits
 * stay local and uncommitted: `gh pr create --head <branch>` then opens a PR
 * from the *remote* branch, which is missing every fix the flow just made (and
 * an escalation comment would describe state nobody else can see). Both
 * terminal nodes call `commitAndPush` before touching the forge.
 */
import { FinishError } from "../errors";
import { runArgv } from "../exec";
import type { RunFn } from "../types";

export const _gitDeps: { run: RunFn } = { run: runArgv };

export interface SyncOutcome {
  /** True when the flow's fixes produced a new commit. */
  committed: boolean;
  /** True when the branch was pushed (always attempted, so the forge sees HEAD). */
  pushed: boolean;
}

async function isDirty(repoRoot: string): Promise<boolean> {
  const status = await _gitDeps.run(["git", "status", "--porcelain"], { cwd: repoRoot });
  if (status.exitCode !== 0) {
    throw new FinishError(
      `git status failed in "${repoRoot}": ${status.stderr.trim() || `exit ${status.exitCode}`}`,
      "FINISH_GIT_STATUS_FAILED",
      { stage: "finish-git", repoRoot },
    );
  }
  return status.stdout.trim().length > 0;
}

/**
 * Commit any outstanding fixes and push the branch to `origin`.
 *
 * The push is unconditional — even with nothing new to commit the local branch
 * may be ahead of its remote (nax's own run commits, or a previous partial
 * finish), and the PR must reflect HEAD.
 */
export async function commitAndPush(repoRoot: string, branch: string, message: string): Promise<SyncOutcome> {
  let committed = false;
  if (await isDirty(repoRoot)) {
    const add = await _gitDeps.run(["git", "add", "-A"], { cwd: repoRoot });
    if (add.exitCode !== 0) {
      throw new FinishError(
        `git add failed in "${repoRoot}": ${add.stderr.trim() || `exit ${add.exitCode}`}`,
        "FINISH_GIT_ADD_FAILED",
        { stage: "finish-git", repoRoot },
      );
    }
    const commit = await _gitDeps.run(["git", "commit", "-m", message], { cwd: repoRoot });
    if (commit.exitCode !== 0) {
      throw new FinishError(
        `git commit failed in "${repoRoot}": ${commit.stderr.trim() || commit.stdout.trim() || `exit ${commit.exitCode}`}`,
        "FINISH_GIT_COMMIT_FAILED",
        { stage: "finish-git", repoRoot, branch },
      );
    }
    committed = true;
  }

  const push = await _gitDeps.run(["git", "push", "--set-upstream", "origin", branch], { cwd: repoRoot });
  if (push.exitCode !== 0) {
    throw new FinishError(
      `git push of "${branch}" failed: ${push.stderr.trim() || `exit ${push.exitCode}`}`,
      "FINISH_GIT_PUSH_FAILED",
      { stage: "finish-git", repoRoot, branch, committed },
    );
  }
  return { committed, pushed: true };
}
