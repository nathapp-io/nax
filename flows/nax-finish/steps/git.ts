/**
 * Branch synchronisation for the nax-finish flow.
 *
 * Every fix node edits the working tree in place, which two different consumers
 * would otherwise miss:
 *
 * - The **reviewers** read `git diff <base>...HEAD` — committed history only.
 *   With the fixes uncommitted, every re-review re-read the pre-fix code and
 *   re-reported findings the fix node had already resolved, so the loop could
 *   never converge and always escalated at the fix cap (issue #1397). Each
 *   `commit_*` node calls `commitFixes` for this reason.
 * - The **forge**: `gh pr create --head <branch>` opens a PR from the *remote*
 *   branch, and an escalation comment would describe state nobody else can see.
 *   Both terminal nodes call `commitAndPush` before touching the forge.
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
 * Commit the working tree, if it has anything in it, without pushing.
 *
 * Called by the `commit_*` nodes after every fix node so the next reviewer's
 * `git diff <base>...HEAD` contains the fix. `git add -A` (not `-u`) because a
 * fix routinely adds a *new* test file, and an untracked file is invisible to
 * that diff — which is also why committing beats widening the reviewer's diff
 * to include the working tree.
 *
 * `skipHooks` (used by every mid-loop `commit_*` node) adds `--no-verify`. Those
 * commits are internal checkpoints, not shipped history: a repo whose
 * pre-commit hook runs lint or typecheck would otherwise reject an intermediate
 * state — a lint error the gate loop was about to fix — and take the whole flow
 * down with it, with no result file. Nothing is lost by skipping them, because
 * `quality_gates` runs the repo's own build/typecheck/lint/test and no PR opens
 * unless they are green. The terminal `commitAndPush` leaves hooks enabled.
 *
 * A failing commit still throws: the fix is then unreviewable, and continuing
 * would silently reproduce the stale-diff bug this exists to fix.
 */
/** Current HEAD sha, or null outside a repo / on an unborn branch. */
async function headSha(repoRoot: string): Promise<string | null> {
  const res = await _gitDeps.run(["git", "rev-parse", "HEAD"], { cwd: repoRoot });
  return res.exitCode === 0 ? res.stdout.trim() || null : null;
}

/**
 * Repo-root-relative paths touched by a commit.
 *
 * `--format=` suppresses the header so the output is just the file list.
 * Failure yields `[]`, which the gate loop reads as "cannot tell what changed"
 * and therefore reviews — see `partitionTestFiles`.
 */
export async function filesInCommit(repoRoot: string, sha: string): Promise<string[]> {
  const res = await _gitDeps.run(["git", "show", "--name-only", "--format=", sha], { cwd: repoRoot });
  if (res.exitCode !== 0) return [];
  return res.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

export async function commitFixes(
  repoRoot: string,
  message: string,
  opts: { skipHooks?: boolean } = {},
): Promise<{ committed: boolean; shaBefore: string | null; shaAfter: string | null }> {
  const shaBefore = await headSha(repoRoot);
  if (!(await isDirty(repoRoot))) return { committed: false, shaBefore, shaAfter: shaBefore };

  const add = await _gitDeps.run(["git", "add", "-A"], { cwd: repoRoot });
  if (add.exitCode !== 0) {
    throw new FinishError(
      `git add failed in "${repoRoot}": ${add.stderr.trim() || `exit ${add.exitCode}`}`,
      "FINISH_GIT_ADD_FAILED",
      { stage: "finish-git", repoRoot },
    );
  }
  const commitArgv = ["git", "commit", "-m", message, ...(opts.skipHooks ? ["--no-verify"] : [])];
  const commit = await _gitDeps.run(commitArgv, { cwd: repoRoot });
  if (commit.exitCode !== 0) {
    throw new FinishError(
      `git commit failed in "${repoRoot}": ${commit.stderr.trim() || commit.stdout.trim() || `exit ${commit.exitCode}`}`,
      "FINISH_GIT_COMMIT_FAILED",
      { stage: "finish-git", repoRoot },
    );
  }
  return { committed: true, shaBefore, shaAfter: await headSha(repoRoot) };
}

/**
 * Commit any outstanding fixes and push the branch to `origin`.
 *
 * The push is unconditional — even with nothing new to commit the local branch
 * may be ahead of its remote (nax's own run commits, or the `commit_*` nodes'
 * per-round commits), and the PR must reflect HEAD.
 */
export async function commitAndPush(repoRoot: string, branch: string, message: string): Promise<SyncOutcome> {
  const { committed } = await commitFixes(repoRoot, message);

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
