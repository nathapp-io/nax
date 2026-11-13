/**
 * Shared branch synchronisation on nax's own git helper.
 *
 * Fixes must be committed so reviewers see them in `git diff <base>...HEAD`;
 * publishing pushes the branch so the forge sees the same history.
 * `_finishGitDeps.git` already prepends "git", so argv here omits it.
 */

import { gitlinkSafeAdd, hasStagedChanges } from "@nathapp/nax-agent/internal";
import { NaxError } from "../errors";
import { gitWithTimeout } from "../utils/git";
import { relativeInsideRoot } from "./safe-path";

export const _finishGitDeps = { git: gitWithTimeout };

/**
 * Push can legitimately outrun the 10s default in `@/utils/git`; a gate that
 * times out mid-push would report a failure that already half-happened.
 */
export const PUSH_TIMEOUT_MS = 120_000;

/** Where a branch lives on the remote; koda's flow branch and nax's publish path both push here. */
const BRANCH_REF_PREFIX = "refs/heads/";

export interface SyncOutcome {
  /** True when the fixes produced a new commit. */
  committed: boolean;
  /** True when the branch was pushed (always attempted, so the forge sees HEAD). */
  pushed: boolean;
  /** HEAD after the commit, when the fixes produced one. */
  sha?: string | null;
}

export async function isDirty(repoRoot: string): Promise<boolean> {
  const status = await _finishGitDeps.git(["status", "--porcelain"], repoRoot);
  if (status.exitCode !== 0) {
    throw new NaxError(
      `git status failed in "${repoRoot}": ${status.stderr.trim() || `exit ${status.exitCode}`}`,
      "FINISH_GIT_STATUS_FAILED",
      { stage: "finish-git", repoRoot },
    );
  }
  return status.stdout.trim().length > 0;
}

/** Current HEAD sha, or null outside a repo / on an unborn branch. */
export async function headSha(repoRoot: string): Promise<string | null> {
  const res = await _finishGitDeps.git(["rev-parse", "HEAD"], repoRoot);
  return res.exitCode === 0 ? res.stdout.trim() || null : null;
}

/** nax's own audit dir can sit inside the repo (no .gitignore section): it is never committed. */
async function unstageDir(repoRoot: string, dir: string): Promise<void> {
  const rel = await relativeInsideRoot(repoRoot, dir);
  if (rel === null) return;
  await _finishGitDeps.git(["--literal-pathspecs", "reset", "-q", "--", rel], repoRoot);
}

/**
 * Commit the working tree, if it has anything in it, without pushing.
 *
 * Called after every fix step so the next reviewer's `git diff <base>...HEAD`
 * contains the fix. `git add -A` (not `-u`) because a fix routinely adds a
 * *new* test file, and an untracked file is invisible to that diff — which is
 * also why committing beats widening the reviewer's diff to include the
 * working tree.
 *
 * `skipHooks` (used by every mid-loop checkpoint) adds `--no-verify`. Those
 * commits are internal checkpoints, not shipped history: a repo whose
 * pre-commit hook runs lint or typecheck would otherwise reject an
 * intermediate state — a lint error the gate loop was about to fix — and take
 * the whole run down with it, with no result file. Nothing is lost by
 * skipping them, because the quality gate runs the repo's own
 * build/typecheck/lint/test and no PR opens unless they are green. The
 * terminal `commitAndPush` leaves hooks enabled.
 *
 * A failing commit still throws: the fix is then unreviewable, and continuing
 * would silently reproduce the stale-diff bug this exists to fix.
 */
export async function commitFixes(
  repoRoot: string,
  message: string,
  opts: { skipHooks?: boolean; excludeDir?: string } = {},
): Promise<{ committed: boolean; shaBefore: string | null; shaAfter: string | null }> {
  const shaBefore = await headSha(repoRoot);
  if (!(await isDirty(repoRoot))) return { committed: false, shaBefore, shaAfter: shaBefore };

  const add = await gitlinkSafeAdd(_finishGitDeps.git, repoRoot, { flags: ["-A"] }); // #2210
  if (add.exitCode !== 0) {
    throw new NaxError(
      `git add failed in "${repoRoot}": ${add.stderr.trim() || `exit ${add.exitCode}`}`,
      "FINISH_GIT_ADD_FAILED",
      { stage: "finish-git", repoRoot },
    );
  }
  if (opts.excludeDir) await unstageDir(repoRoot, opts.excludeDir);
  // Never run a commit that would only print status: that can recurse into a gitlink (#2210).
  const staged = await hasStagedChanges(_finishGitDeps.git, repoRoot);
  if (staged === false) return { committed: false, shaBefore, shaAfter: shaBefore };
  if (staged === undefined) {
    throw new NaxError(`could not tell whether anything is staged in "${repoRoot}"`, "FINISH_GIT_STAGED_CHECK_FAILED", {
      stage: "finish-git",
      repoRoot,
    });
  }
  const commitArgv = ["commit", "-m", message, ...(opts.skipHooks ? ["--no-verify"] : [])];
  const commit = await _finishGitDeps.git(commitArgv, repoRoot);
  if (commit.exitCode !== 0) {
    throw new NaxError(
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
 * The push is unconditional — even with nothing new to commit the local
 * branch may be ahead of its remote (nax's own run commits, or per-round
 * checkpoint commits), and the PR must reflect HEAD.
 *
 * `sourceSha` binds the push to one commit: the refspec becomes
 * `<sourceSha>:refs/heads/<branch>`, so what reaches the remote is that object
 * whatever the local branch points at when the push runs. A caller that showed
 * the user a specific commit — an approval card naming a sha — passes it, because
 * a name-addressed push resolves `refs/heads/<branch>` at push time and a
 * concurrent commit would otherwise be what gets published. Such a push cannot
 * set the branch's upstream (git derives it from a local branch refspec), so a
 * branch that had none still has none afterwards.
 */
export async function commitAndPush(
  repoRoot: string,
  branch: string,
  message: string,
  opts: { skipHooks?: boolean; skipCommit?: boolean; excludeDir?: string; sourceSha?: string } = {},
): Promise<SyncOutcome> {
  const { committed, shaAfter } = opts.skipCommit
    ? { committed: false, shaAfter: null }
    : await commitFixes(repoRoot, message, opts);

  const source = opts.sourceSha === undefined ? branch : `${opts.sourceSha}:${BRANCH_REF_PREFIX}${branch}`;
  const push = await _finishGitDeps.git(["push", "--set-upstream", "origin", source], repoRoot, PUSH_TIMEOUT_MS);
  if (push.exitCode !== 0) {
    throw new NaxError(
      `git push of "${branch}" failed: ${push.stderr.trim() || `exit ${push.exitCode}`}`,
      "FINISH_GIT_PUSH_FAILED",
      {
        stage: "finish-git",
        repoRoot,
        branch,
        ...(opts.sourceSha === undefined ? {} : { sourceSha: opts.sourceSha }),
        committed,
      },
    );
  }
  return { committed, pushed: true, ...(committed ? { sha: shaAfter } : {}) };
}
