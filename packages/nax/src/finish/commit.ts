/**
 * Shared branch synchronisation on nax's own git helper.
 *
 * Fixes must be committed so reviewers see them in `git diff <base>...HEAD`;
 * publishing pushes the branch so the forge sees the same history.
 * `_finishGitDeps.git` already prepends "git", so argv here omits it.
 */

import { gitlinkSafeAdd, hasStagedChanges } from "@nathapp/nax-agent/internal";
import { NaxError } from "../errors";
import { gitWithTimeout, NO_TERMINAL_PROMPT } from "../utils/git";
import { redactUrlUserinfo } from "../utils/redact-url";
import { relativeInsideRoot } from "./safe-path";

export const _finishGitDeps = { git: gitWithTimeout, randomUUID: () => crypto.randomUUID() };

/**
 * Push can legitimately outrun the 10s default in `@/utils/git`; a gate that
 * times out mid-push would report a failure that already half-happened.
 */
export const PUSH_TIMEOUT_MS = 120_000;

/** Where a branch lives on the remote; koda's flow branch and nax's publish path both push here. */
const BRANCH_REF_PREFIX = "refs/heads/";
/** The remote a push names when the caller did not resolve the destination itself. */
const DEFAULT_PUSH_REMOTE = "origin";

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
 * One process-local git configuration entry, as a key and its value separately.
 * They travel through `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n` rather than a
 * `-c key=value` argument (see `boundPush` for why).
 */
type GitConfigEntry = readonly [key: string, value: string];

/** A non-negative integer, the only shape `GIT_CONFIG_COUNT` may carry. */
const NON_NEGATIVE_INT = /^\d+$/;

/**
 * An environment overlay applying `config` to one git process, appended after
 * whatever `GIT_CONFIG_COUNT` the environment already carries so an existing
 * entry is not displaced. Mirrors what `hardenedGitEnv` does for its own
 * entries, which are appended after these.
 */
function configOverlay(config: readonly GitConfigEntry[]): Record<string, string> {
  const existing = process.env.GIT_CONFIG_COUNT;
  const start = existing !== undefined && NON_NEGATIVE_INT.test(existing) ? Number.parseInt(existing, 10) : 0;
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(start + config.length) };
  config.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${start + index}`] = key;
    env[`GIT_CONFIG_VALUE_${start + index}`] = value;
  });
  return env;
}

/**
 * Bind a URL without letting Git rewrite it again. Git rewrites each explicit
 * pushurl once with insteadOf and ignores pushInsteadOf for explicit pushurls.
 * A fresh opaque alias is the only rewrite input; our exact-match rule wins over
 * configured prefixes. Its replacement is the verified URL, which is NOT rewritten
 * recursively. All settings are process-local; authentication config remains
 * available and no temporary remote is persisted to the repository.
 *
 * The entries are passed through `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n`, not
 * through `-c key=value`: git splits a `-c` argument at its first `=`, and a
 * credential-bearing HTTPS destination routinely contains one
 * (`https://x-access-token:ab=c@github.com/o/r.git`). There the split lands
 * inside the userinfo, so git rejects `url.https://x-access-token:ab` as an
 * invalid key and prints that prefix — the credential — into its stderr, which
 * the caller then sees. Key and value kept apart cannot be re-split, whatever
 * the destination contains.
 */
function boundPush(destination: string): { argv: string[]; config: GitConfigEntry[] } {
  const remote = `nax-bound-${_finishGitDeps.randomUUID()}`;
  const alias = `${remote}://push`;
  return {
    argv: ["push", "--set-upstream", remote],
    config: [
      [`remote.${remote}.url`, alias],
      [`remote.${remote}.pushurl`, alias],
      [`url.${destination}.insteadOf`, alias],
    ],
  };
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
 *
 * `remote` binds the destination: a caller that verified where a push goes passes
 * the URL it verified, rather than naming `origin` and letting git resolve the
 * remote again — a remote's push URL can differ from its fetch URL (`pushurl`) and
 * can be rewritten between the check and the push. A process-local alias binds
 * that URL without recursively applying Git's URL rewrites (see boundPush).
 * Its transport (SSH, a credential-bearing HTTPS URL) still authenticates. The URL
 * is never put in an error message or context, because it may carry a credential.
 *
 * `signal` kills the push when aborted; the push then fails like any other (the
 * caller decides whether a failure after its own abort is a cancel). The git
 * terminal prompt is always off, so missing credentials fail at once.
 */
export async function commitAndPush(
  repoRoot: string,
  branch: string,
  message: string,
  opts: {
    skipHooks?: boolean;
    skipCommit?: boolean;
    excludeDir?: string;
    sourceSha?: string;
    remote?: string;
    signal?: AbortSignal;
  } = {},
): Promise<SyncOutcome> {
  const { committed, shaAfter } = opts.skipCommit
    ? { committed: false, shaAfter: null }
    : await commitFixes(repoRoot, message, opts);

  const source = opts.sourceSha === undefined ? branch : `${opts.sourceSha}:${BRANCH_REF_PREFIX}${branch}`;
  const bound = opts.remote === undefined ? undefined : boundPush(opts.remote);
  const pushArgs = bound?.argv ?? ["push", "--set-upstream", DEFAULT_PUSH_REMOTE];
  // Parameters 4 and 5 are `maxBytes` and `argvOverride`; the bound destination's
  // configuration is part of the environment overlay, deliberately off argv (see boundPush).
  const push = await _finishGitDeps.git(
    [...pushArgs, source],
    repoRoot,
    PUSH_TIMEOUT_MS,
    undefined,
    undefined,
    // Every finish push is non-interactive: a credential prompt would block on the terminal.
    { ...NO_TERMINAL_PROMPT, ...(bound === undefined ? {} : configOverlay(bound.config)) },
    opts.signal,
  );
  if (push.exitCode !== 0) {
    // git quotes the destination it failed on, credentials included, so its own
    // words are redacted before they reach a tool result or a log line.
    throw new NaxError(
      `git push of "${branch}" failed: ${redactUrlUserinfo(push.stderr.trim()) || `exit ${push.exitCode}`}`,
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
