/**
 * Branch synchronisation for `nax finish`, on nax's own git helper.
 *
 * Every fix step edits the working tree in place, which two different
 * consumers would otherwise miss:
 *
 * - The **reviewers** read `git diff <base>...HEAD` — committed history only.
 *   With the fixes uncommitted, every re-review re-read the pre-fix code and
 *   re-reported findings the fix step had already resolved, so the loop could
 *   never converge and always escalated at the fix cap (issue #1397). Each
 *   `commit_*` step calls `commitFixes` for this reason.
 * - The **forge**: `gh pr create --head <branch>` opens a PR from the *remote*
 *   branch, and an escalation comment would describe state nobody else can see.
 *   The terminal step calls `commitAndPush` before touching the forge.
 *
 * Ported from `flows/nax-finish/steps/git.ts` (read-only reference, not
 * imported — `flows/` runs inside acpx's own Node process) plus
 * `flows/nax-finish/steps/commit-round.ts`. Two differences from that source:
 *
 * - `_finishGitDeps.git` is `gitWithTimeout` from `@/utils/git`, not a local
 *   `runArgv` wrapper. `gitWithTimeout` already prepends `"git"` to its argv,
 *   so every call here omits the leading `"git"` element the original argv
 *   led with — passing it through would spawn `git git status`.
 * - `buildCommitRound` drops `attempt` from its input and returns
 *   `Omit<FinishRound, "attempt">`; `recordRound` (`./audit`) is the sole
 *   assigner of that field.
 */
import { NaxError } from "../errors";
import { gitWithTimeout } from "../utils/git";
import type { Finding, FindingDisposition, FinishPhase, FinishRound, FinishRoundOutcome } from "./types";

export const _finishGitDeps = { git: gitWithTimeout };

/**
 * Push can legitimately outrun the 10s default in `@/utils/git`; a gate that
 * times out mid-push would report a failure that already half-happened.
 */
export const PUSH_TIMEOUT_MS = 120_000;

export interface SyncOutcome {
  /** True when the fixes produced a new commit. */
  committed: boolean;
  /** True when the branch was pushed (always attempted, so the forge sees HEAD). */
  pushed: boolean;
}

async function isDirty(repoRoot: string): Promise<boolean> {
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

/**
 * Current HEAD sha, or null outside a repo / on an unborn branch.
 *
 * Exported (beyond this module's own use in `commitFixes`) for the finish
 * ledger (#1674 part 1): `machine.ts` stamps every terminal `FinishResult`
 * with the HEAD it finished at, so a later run's entry check
 * (`context.ts`'s `already-finished` route) can compare it against the
 * ledger without duplicating this call.
 */
export async function headSha(repoRoot: string): Promise<string | null> {
  const res = await _finishGitDeps.git(["rev-parse", "HEAD"], repoRoot);
  return res.exitCode === 0 ? res.stdout.trim() || null : null;
}

/**
 * Repo-root-relative paths touched by a commit.
 *
 * `--format=` suppresses the header so the output is just the file list.
 * Failure yields `[]`, which the gate loop reads as "cannot tell what
 * changed" and therefore reviews — see `gateCommitRoute` in `./route`.
 */
export async function filesInCommit(repoRoot: string, sha: string): Promise<string[]> {
  const res = await _finishGitDeps.git(["show", "--name-only", "--format=", sha], repoRoot);
  if (res.exitCode !== 0) return [];
  return res.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
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
  opts: { skipHooks?: boolean } = {},
): Promise<{ committed: boolean; shaBefore: string | null; shaAfter: string | null }> {
  const shaBefore = await headSha(repoRoot);
  if (!(await isDirty(repoRoot))) return { committed: false, shaBefore, shaAfter: shaBefore };

  const add = await _finishGitDeps.git(["add", "-A"], repoRoot);
  if (add.exitCode !== 0) {
    throw new NaxError(
      `git add failed in "${repoRoot}": ${add.stderr.trim() || `exit ${add.exitCode}`}`,
      "FINISH_GIT_ADD_FAILED",
      { stage: "finish-git", repoRoot },
    );
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
 */
export async function commitAndPush(repoRoot: string, branch: string, message: string): Promise<SyncOutcome> {
  const { committed } = await commitFixes(repoRoot, message);

  const push = await _finishGitDeps.git(["push", "--set-upstream", "origin", branch], repoRoot, PUSH_TIMEOUT_MS);
  if (push.exitCode !== 0) {
    throw new NaxError(
      `git push of "${branch}" failed: ${push.stderr.trim() || `exit ${push.exitCode}`}`,
      "FINISH_GIT_PUSH_FAILED",
      {
        stage: "finish-git",
        repoRoot,
        branch,
        committed,
      },
    );
  }
  return { committed, pushed: true };
}

/** Phases that own a reviewer step; every other phase's round has nobody behind it. */
const REVIEWED_PHASES: FinishPhase[] = ["spec", "quality"];

/**
 * What produced this round, given the successor the commit routed to.
 *
 * `route` no longer changes the answer, and that is the point: since #1510
 * every committed gate fix re-enters the quality review, so no route can skip
 * an owed re-review. The parameter stays because the round is still keyed on
 * the successor conceptually, and a future route that *does* bypass a
 * reviewer would need to be reflected here rather than silently inheriting
 * `no-reviewer`.
 */
export function commitRoundOutcome(phase: FinishPhase, _route: string): FinishRoundOutcome {
  if (REVIEWED_PHASES.includes(phase)) return "fixed";
  return "no-reviewer";
}

export interface CommitRoundInput {
  phase: FinishPhase;
  committed: boolean;
  /** The successor this commit routed to — see `commitRoundOutcome`. */
  route: string;
  findings: Finding[];
  /** Gate commands that were red this round; omitted for non-gate phases. */
  failing?: string[];
  /** Post-commit HEAD, when there was a commit. */
  shaAfter?: string | null;
  now: string;
  /** What the fixer did with each finding it was handed (spec/quality phases). */
  dispositions?: FindingDisposition[];
}

/**
 * Build the round record for a commit checkpoint.
 *
 * Drops `attempt` from its input: `recordRound` (`./audit`) is the sole
 * assigner of that field (D2.3), so a builder that also set it would be the
 * second writer that field's ownership rule exists to prevent.
 *
 * `sha` and `failing` are omitted rather than set to null/undefined: a reader
 * of the JSONL distinguishes "no commit" from "record lost" by the key's
 * absence, and that only works if absence is never used to mean anything else.
 */
export function buildCommitRound(i: CommitRoundInput): Omit<FinishRound, "attempt"> {
  return {
    ts: i.now,
    phase: i.phase,
    committed: i.committed,
    outcome: commitRoundOutcome(i.phase, i.route),
    findings: i.findings,
    route: i.route,
    ...(i.failing ? { failing: i.failing } : {}),
    ...(i.committed && i.shaAfter ? { sha: i.shaAfter } : {}),
    ...(i.dispositions && i.dispositions.length > 0 ? { dispositions: i.dispositions } : {}),
  };
}
