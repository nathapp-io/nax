/**
 * Commit `prd.json` alone, after a story status write (#2533).
 *
 * Every stage that changes a story's status writes the whole PRD back to disk —
 * completion, the result handler, queue-check. Nothing committed it, so the
 * status change sat in the working tree as a modification the next story's
 * agent did not make. The consequences were all real: the agent saw a dirty
 * file it could not explain, the next `autoCommitIfDirty` swept the status
 * write into the wrong story's commit, and a stray `git checkout .` reset a
 * finished story to `pending` (#2490).
 *
 * The commit is pathspec-scoped to the PRD, so an unrelated edit — staged or
 * not — is neither committed nor disturbed. It carries `--no-verify`, matching
 * the ledger commit (`workflow/git.ts`): nax's own bookkeeping must not be
 * blocked or reshaped by a hook. Deliberately no `[skip ci]`: a skipped
 * required check blocks a merge.
 *
 * Nothing here is fatal. A repository that ignores its PRD, or a git step that
 * fails, leaves the story outcome exactly as it was — the PRD on disk is
 * already correct; only the commit is missing.
 */

import { basename, dirname } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { getLogger } from "@/logger";
import { gitWithTimeout } from "../utils/git";
import { savePRD } from "./save";
import type { PRD } from "./types";

/** The stdio of one git step — what this module reads, out of `gitWithTimeout`'s full result. */
export interface PrdGitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Bound on the stderr text a warn carries, so one broken command cannot flood the log. */
const MAX_STDERR_CHARS = 500;

export interface PrdProgressCommitOptions {
  /** Absolute path to the feature's `prd.json`; its directory is the git cwd. */
  prdPath: string;
  /** Feature name for the commit subject — `chore(<feature>): progress <storyId> <label>`. */
  feature: string;
  storyId: string;
  /** What happened to the story: `passed`, `failed`, `paused`, `skipped`, … */
  label: string;
}

/**
 * `gitWithTimeout`, narrowed to the two arguments this module passes. The
 * narrower signature is the seam: a test assigns a plain async function to it
 * and answers each step by name.
 */
export const _prdCommitDeps: { git: (args: string[], cwd: string) => Promise<PrdGitResult> } = {
  git: gitWithTimeout,
};

/** The subject every PRD progress commit carries. */
function prdProgressCommitMessage(feature: string, storyId: string, label: string): string {
  return `chore(${feature}): progress ${storyId} ${label}`;
}

/** git's own words when it has any, else its exit code. */
function gitDetail(result: PrdGitResult): string {
  return result.stderr.trim().slice(0, MAX_STDERR_CHARS) || `exit ${result.exitCode}`;
}

/** The one warn this module may emit. Always `false`, so callers can `return` it. */
function warnCommitFailure(storyId: string, path: string, step: string, detail: string): false {
  getLogger().warn("prd", "Failed to commit PRD progress", { storyId, path, step, detail });
  return false;
}

/**
 * Commit `prdPath` when it changed. Resolves `true` only when this call created
 * a commit; `false` covers "no change", "ignored" and "git failed". Never throws.
 */
export async function commitPrdProgress(options: PrdProgressCommitOptions): Promise<boolean> {
  const { prdPath, feature, storyId, label } = options;
  const cwd = dirname(prdPath);
  const path = basename(prdPath);
  try {
    // First, because an ignored PRD makes the `add` below fail by design and
    // that refusal is expected rather than something to report. It also keeps
    // nax from forcing the file past the user's own ignore rule.
    const ignored = await _prdCommitDeps.git(["check-ignore", "-q", "--", path], cwd);
    if (ignored.exitCode === 0) return false;

    const added = await _prdCommitDeps.git(["add", "--", path], cwd);
    if (added.exitCode !== 0) return warnCommitFailure(storyId, path, "add", gitDetail(added));

    // The pathspec-scoped index is the only reliable "did this path change"
    // answer: exit 0 means nothing is staged for it.
    const staged = await _prdCommitDeps.git(["diff", "--cached", "--quiet", "--", path], cwd);
    if (staged.exitCode === 0) return false;

    const message = prdProgressCommitMessage(feature, storyId, label);
    const commit = await _prdCommitDeps.git(["commit", "--no-verify", "-m", message, "--", path], cwd);
    if (commit.exitCode !== 0) return warnCommitFailure(storyId, path, "commit", gitDetail(commit));
    return true;
  } catch (err) {
    return warnCommitFailure(storyId, path, "git", errorMessage(err));
  }
}

/**
 * `savePRD`, then commit it. The pair every status-write call site wants: one
 * line in place of the `savePRD` it replaced.
 */
export async function savePrdProgress(prd: PRD, prdPath: string, storyId: string, label: string): Promise<void> {
  await savePRD(prd, prdPath);
  await commitPrdProgress({ prdPath, feature: prd.feature, storyId, label });
}
