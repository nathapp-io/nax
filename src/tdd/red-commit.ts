/**
 * The TDD RED commit (docs/superpowers/specs/2026-09-26-tdd-red-commit-design.md).
 *
 * After a successful test-writer phase the story orchestrator commits the
 * files that phase changed, so the implementer's `beforeRef` is a committed
 * boundary rather than a tree that still holds the test-writer's work.
 *
 * Hooks are skipped by default (`--no-verify`), exactly as the finish loop's
 * checkpoints are (src/finish/commit.ts): a RED suite may not typecheck until
 * the implementer adds the symbols its tests reference, and a pre-commit
 * typecheck would reject it. quality.commands, the review checks and the
 * deferred regression gate remain the mechanical gate.
 *
 * Every git call runs from the repository root: `git diff --name-only` and
 * `git status --porcelain` print root-relative paths even from a package
 * subdirectory. Never throws.
 */
import { NaxError } from "../errors";
import { getSafeLogger } from "../logger";
import { partitionNaxOwnedPaths } from "../tools";
import { errorMessage } from "../utils/errors";
import { gitWithTimeout } from "../utils/git";
import { gitlinkSafeAdd } from "../utils/git-add";
import { realOrRaw } from "../utils/realpath";
import { getChangedFiles } from "./isolation";

const RED_COMMIT_GIT_TIMEOUT_MS = 30_000;

export interface RedCommitOptions {
  readonly workdir: string;
  readonly beforeRef: string;
  readonly storyId: string;
  readonly hooks: "skip" | "run";
  readonly dryRun: boolean;
  readonly blockedWorktrees?: ReadonlySet<string>;
}

export type RedCommitResult =
  | { readonly status: "committed"; readonly files: readonly string[]; readonly hooksSkipped: boolean }
  | { readonly status: "skipped"; readonly reason: "dry-run" | "blocked-worktree" | "nothing-to-commit" }
  | { readonly status: "failed"; readonly reason: string };

/** Swappable dependencies for testing (avoids mock.module()). */
export const _redCommitDeps = {
  git: (args: string[], cwd: string, timeoutMs?: number) => gitWithTimeout(args, cwd, timeoutMs),
  getChangedFiles,
  partitionNaxOwnedPaths,
};

export type RedCommitDeps = typeof _redCommitDeps;

const NOTHING: RedCommitResult = { status: "skipped", reason: "nothing-to-commit" };

export function redCommitMessage(storyId: string): string {
  return `chore(${storyId}): auto-commit after test-writer session (RED)`;
}

export async function commitRedState(
  opts: RedCommitOptions,
  deps: RedCommitDeps = _redCommitDeps,
): Promise<RedCommitResult> {
  if (opts.dryRun) return { status: "skipped", reason: "dry-run" };
  try {
    return await commitFromRoot(opts, deps);
  } catch (err) {
    return { status: "failed", reason: errorMessage(err) };
  }
}

async function commitFromRoot(opts: RedCommitOptions, deps: RedCommitDeps): Promise<RedCommitResult> {
  const top = await deps.git(["rev-parse", "--show-toplevel"], opts.workdir, RED_COMMIT_GIT_TIMEOUT_MS);
  if (top.exitCode !== 0) return { status: "failed", reason: `git rev-parse failed: ${top.stderr.trim()}` };
  const gitRoot = top.stdout.trim();
  if (isBlocked(gitRoot, opts)) return { status: "skipped", reason: "blocked-worktree" };
  const changed = await deps.getChangedFiles(opts.workdir, opts.beforeRef);
  const files = await expandUntrackedDirs(gitRoot, changed, deps);
  const { kept } = await deps.partitionNaxOwnedPaths(gitRoot, files);
  if (kept.length === 0) return NOTHING;
  const addOpts = { pathspecs: kept, timeoutMs: RED_COMMIT_GIT_TIMEOUT_MS };
  const added = await gitlinkSafeAdd(deps.git, gitRoot, addOpts);
  if (added.exitCode !== 0) return { status: "failed", reason: `git add failed: ${added.stderr.trim()}` };
  const staged = await deps.git(["diff", "--cached", "--quiet", "--", ...kept], gitRoot, RED_COMMIT_GIT_TIMEOUT_MS);
  if (staged.timedOut || (staged.exitCode !== 0 && staged.exitCode !== 1)) {
    return { status: "failed", reason: `git diff --cached failed: ${staged.stderr.trim()}` };
  }
  if (staged.exitCode === 0) return NOTHING;
  const noVerify = opts.hooks === "skip" ? ["--no-verify"] : [];
  // --only builds this commit from the named paths and leaves unrelated staged entries in the caller's index.
  const argv = ["commit", "--only", "-m", redCommitMessage(opts.storyId), ...noVerify, "--", ...kept];
  const committed = await deps.git(argv, gitRoot, RED_COMMIT_GIT_TIMEOUT_MS);
  if (committed.exitCode !== 0) {
    const detail = committed.stderr.trim() || `exit ${committed.exitCode}`;
    return { status: "failed", reason: `git commit failed: ${detail}` };
  }
  return { status: "committed", files: kept, hooksSkipped: opts.hooks === "skip" };
}

function isBlocked(gitRoot: string, opts: RedCommitOptions): boolean {
  if (!opts.blockedWorktrees?.size) return false;
  const root = realOrRaw(gitRoot);
  const blocked = [...opts.blockedWorktrees].filter((tree) => realOrRaw(tree) === root);
  if (blocked.length === 0) return false;
  const message = "Refusing to commit the RED state — working tree may still hold an unreverted mutation";
  getSafeLogger()?.error("tdd", message, {
    storyId: opts.storyId,
    workdir: opts.workdir,
    blocked,
    hint: "Check the mutation-check log for the file and line, restore it, then commit manually.",
  });
  return true;
}

/**
 * `git status --porcelain` reports a brand-new untracked directory as one
 * `dir/` entry. Expand each to its files so the nax-owned filter sees
 * individual paths — a collapsed `.nax/` must never be staged whole.
 */
async function expandUntrackedDirs(gitRoot: string, paths: readonly string[], deps: RedCommitDeps): Promise<string[]> {
  const out: string[] = [];
  for (const path of paths) {
    if (!path.endsWith("/")) {
      out.push(path);
      continue;
    }
    const args = ["ls-files", "--others", "--exclude-standard", "-z", "--", path];
    const listed = await deps.git(args, gitRoot, RED_COMMIT_GIT_TIMEOUT_MS);
    if (listed.exitCode !== 0) {
      throw new NaxError(`git ls-files failed: ${listed.stderr.trim()}`, "GIT_LS_FILES_FAILED", {
        stage: "tdd-red-commit",
        path,
      });
    }
    out.push(...listed.stdout.split("\0").filter(Boolean));
  }
  return out;
}
