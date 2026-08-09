/**
 * Git utility functions
 */

import { getSafeLogger } from "../logger";
import { spawn } from "./bun-deps";
import { realOrRaw } from "./realpath";

/**
 * Default timeout for git subprocess calls.
 * Prevents git from hanging indefinitely on locked repos or network mounts.
 */
const GIT_TIMEOUT_MS = 10_000;

/**
 * Timeout for the git subprocesses captureWorkingTreeChanges spawns during
 * timeout-retry recovery. Scoped separately from GIT_TIMEOUT_MS so it doesn't
 * shrink the timeout for unrelated callers (captureOutputFiles, findMergeBase,
 * etc.) — a hung git here must not stall the already-timed-out agent turn.
 */
const TIMEOUT_RETRY_GIT_TIMEOUT_MS = 3_000;

/**
 * Injectable dependencies for git subprocess calls — allows tests to intercept
 * Bun.spawn without mock.module().
 *
 * `timeoutRetryGitTimeoutMs` is injectable so the hang-path tests can assert the
 * SIGKILL contract without burning the full production timeout in wall-clock.
 *
 * @internal
 */
export const _gitDeps = {
  spawn,
  getSafeLogger,
  timeoutRetryGitTimeoutMs: TIMEOUT_RETRY_GIT_TIMEOUT_MS,
};

/**
 * Return the absolute path of the git repository root for the given workdir.
 * Returns null if workdir is not inside a git repo or the command fails.
 */
export async function getGitRoot(workdir: string): Promise<string | null> {
  try {
    const { stdout, exitCode } = await gitWithTimeout(["rev-parse", "--show-toplevel"], workdir);
    if (exitCode !== 0) return null;
    const trimmed = stdout.trim();
    return trimmed || null;
  } catch {
    return null;
  }
}

/**
 * Spawn a git command with a hard timeout.
 *
 * Kills the process with SIGKILL after GIT_TIMEOUT_MS if it hasn't exited.
 * Returns empty stdout and exit code 1 on timeout.
 *
 * @internal
 */
export async function gitWithTimeout(
  args: string[],
  workdir: string,
  timeoutMs: number = GIT_TIMEOUT_MS,
): Promise<{ stdout: string; exitCode: number }> {
  const proc = _gitDeps.spawn(["git", ...args], {
    cwd: workdir,
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  const timerId = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill("SIGKILL");
    } catch {
      // Process may have already exited
    }
  }, timeoutMs);

  const exitCode = await proc.exited;
  clearTimeout(timerId);

  if (timedOut) {
    return { stdout: "", exitCode: 1 };
  }

  const stdout = await new Response(proc.stdout).text();
  return { stdout, exitCode };
}

/**
 * Capture current git HEAD ref.
 *
 * Returns the current HEAD commit hash, or undefined if git is not available
 * or the command fails (e.g., not in a git repo).
 *
 * @param workdir - Working directory to run git command in
 * @returns Git HEAD ref or undefined on failure
 *
 * @example
 * ```typescript
 * const ref = await captureGitRef("/path/to/repo");
 * if (ref) {
 *   console.log(`Current HEAD: ${ref}`);
 * }
 * ```
 */
export async function captureGitRef(workdir: string): Promise<string | undefined> {
  try {
    const { stdout, exitCode } = await gitWithTimeout(["rev-parse", "HEAD"], workdir);
    if (exitCode !== 0) return undefined;
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Verify that a git ref (SHA or branch name) is reachable in the given workdir.
 * Used to validate a persisted storyGitRef before using it in a diff range.
 *
 * @returns true if the ref resolves successfully, false otherwise
 */
export async function isGitRefValid(workdir: string, ref: string): Promise<boolean> {
  try {
    const { exitCode } = await gitWithTimeout(["cat-file", "-e", `${ref}^{commit}`], workdir);
    return exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Return the merge-base SHA between HEAD and the default remote branch.
 * Tries `origin/main` first, then `origin/master`.
 * Falls back to the oldest reachable commit when no remote branch exists.
 *
 * Used as a fallback for storyGitRef when the stored ref is missing or invalid
 * (e.g. after a rebase, or on a brand-new run where no ref was persisted yet).
 */
export async function getMergeBase(workdir: string): Promise<string | undefined> {
  for (const branch of ["origin/main", "origin/master"]) {
    try {
      const { stdout, exitCode } = await gitWithTimeout(["merge-base", "HEAD", branch], workdir);
      if (exitCode === 0) {
        const sha = stdout.trim();
        if (sha) return sha;
      }
    } catch {
      // try next branch
    }
  }
  // Last resort: oldest ancestor (initial commit)
  try {
    const { stdout, exitCode } = await gitWithTimeout(["rev-list", "--max-parents=0", "HEAD"], workdir);
    if (exitCode === 0) {
      const sha = stdout.trim().split("\n")[0];
      if (sha) return sha;
    }
  } catch {
    // ignore
  }
  return undefined;
}

/**
 * Check if a story ID appears in recent git commit messages.
 *
 * Searches the last N commits for commit messages containing the story ID.
 * Used for state reconciliation: if a failed story has commits in git history,
 * it means the story was partially completed and should be marked as passed.
 *
 * @param workdir - Working directory to run git command in
 * @param storyId - Story ID to search for (e.g., "US-001")
 * @param maxCommits - Maximum number of commits to search (default: 20)
 * @returns true if story ID found in commit messages, false otherwise
 *
 * @example
 * ```typescript
 * const hasCommits = await hasCommitsForStory("/path/to/repo", "US-001");
 * if (hasCommits) {
 *   console.log("Story US-001 has commits in git history");
 * }
 * ```
 */
export async function hasCommitsForStory(workdir: string, storyId: string, maxCommits = 20): Promise<boolean> {
  try {
    const { stdout, exitCode } = await gitWithTimeout(
      ["log", `-${maxCommits}`, "--oneline", "--grep", storyId],
      workdir,
    );
    if (exitCode !== 0) return false;
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Detect if git operation output contains merge conflict markers.
 *
 * Matches git-specific conflict signals only — not general use of the word
 * "conflict" in agent output (e.g. HTTP 409 Conflict implementations).
 *
 * @param output - Combined stdout/stderr output from a git operation
 * @returns true if output contains git conflict markers
 *
 * @example
 * ```typescript
 * const hasConflict = detectMergeConflict(agentOutput);
 * if (hasConflict) {
 *   // fire merge-conflict trigger
 * }
 * ```
 */
export function detectMergeConflict(output: string): boolean {
  return (
    output.includes("<<<<<<<") ||
    output.includes(">>>>>>>") ||
    // "CONFLICT (content):", "CONFLICT (delete/modify):", etc.
    /\bCONFLICT\s*\(/.test(output) ||
    // "Merge conflict in <file>"
    output.includes("Merge conflict in")
  );
}

/**
 * Re-exports of the porcelain parser for callers that import from
 * `@/utils/git`. The parser itself lives in `./porcelain.ts` to keep the
 * pure string-handling code separate from the subprocess orchestration here.
 * Imported as a value as well so `autoCommitIfDirty` can call it directly
 * without going through the module re-export indirection.
 */
import { parsePorcelainForNaxPaths } from "./porcelain";
export { parsePorcelainForNaxPaths };
export type { NaxProtectedPath } from "./porcelain";

/**
 * Auto-commit safety net.
 *
 * If the agent left uncommitted changes after a session, stage and commit them
 * automatically. Prevents the review stage from failing with "uncommitted
 * changes" errors. No-op when the working tree is clean.
 *
 * Used by session-runner.ts (TDD sessions) and execution.ts (single-session / test-after).
 *
 * @param workdir - Working directory (git repo root)
 * @param stage   - Log stage prefix (e.g. "tdd", "execution")
 * @param role    - Session role for the commit message (e.g. "implementer")
 * @param storyId - Story ID for the commit message
 * @param blockedWorktrees - Working trees known to hold source this run cannot
 *   account for — currently an unreverted mutation from the mutation spot-check
 *   (`runtime.dirtyWorktrees`). A commit under one of these would capture the
 *   injected defect, so it is refused. Omit when the caller has no runtime.
 */
export async function autoCommitIfDirty(
  workdir: string,
  stage: string,
  role: string,
  storyId: string,
  blockedWorktrees?: ReadonlySet<string>,
): Promise<void> {
  const logger = _gitDeps.getSafeLogger();
  try {
    // Guard: only auto-commit if workdir IS the git repository root.
    // Without this, a workdir nested inside another git repo (e.g. a temp dir
    // created inside the nax repo during tests) would cause git to walk up and
    // commit files from the parent repo instead.
    const topLevelProc = _gitDeps.spawn(["git", "rev-parse", "--show-toplevel"], {
      cwd: workdir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const gitRoot = (await new Response(topLevelProc.stdout).text()).trim();
    await topLevelProc.exited;

    // Normalize paths to handle symlinks (e.g. /tmp → /private/tmp on macOS)
    const { realpathSync } = await import("node:fs");
    const realWorkdir = (() => {
      try {
        return realpathSync(workdir);
      } catch {
        return workdir;
      }
    })();
    const realGitRoot = (() => {
      try {
        return realpathSync(gitRoot);
      } catch {
        return gitRoot;
      }
    })();
    // Allow: workdir IS the git root, or workdir is a subdirectory (monorepo package)
    // Reject: workdir has no git repo at all (realGitRoot would be empty/error)
    const isAtRoot = realWorkdir === realGitRoot;
    const isSubdir = realGitRoot && realWorkdir.startsWith(`${realGitRoot}/`);
    if (!isAtRoot && !isSubdir) return;

    // Staging is `git add -A` from the git ROOT, so the question is whether this
    // commit's working tree is a blocked one — compare against `realGitRoot`,
    // not `workdir`, so a monorepo package under a blocked root is still caught.
    //
    // Equality, NOT containment. `blockedWorktrees` holds working-tree roots, and
    // in parallel mode each story's worktree is a LINKED tree at
    // `<repo>/.nax-wt/<storyId>` — inside the main repo by path, but a separate
    // checkout that `git add -A` from the main root never stages. A containment
    // test would block the run-summary commit whenever any story's worktree was
    // dirty, which is a false positive.
    if (blockedWorktrees?.size) {
      const root = realOrRaw(realGitRoot);
      const blocked = [...blockedWorktrees].filter((tree) => realOrRaw(tree) === root);
      if (blocked.length > 0) {
        logger?.error(stage, "Refusing to auto-commit — working tree may still hold an unreverted mutation", {
          storyId,
          role,
          workdir,
          blocked,
          hint: "Check the mutation-check log for the file and line, restore it, then commit manually.",
        });
        return;
      }
    }

    const statusProc = _gitDeps.spawn(["git", "status", "--porcelain"], {
      cwd: workdir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const statusOutput = await new Response(statusProc.stdout).text();
    await statusProc.exited;

    if (!statusOutput.trim()) return;

    logger?.debug(stage, `Agent did not commit after ${role} session — auto-committing`, {
      role,
      storyId,
      dirtyFiles: statusOutput.trim().split("\n").length,
    });

    // Best-effort restore of deleted/renamed .nax/ paths before staging.
    // The snapshot auto-commit swept an acceptance artifact deletion onto the
    // branch after an agent treated it as a stray test file — restore any path
    // under a `.nax/` segment so the auto-commit does not lose nax state.
    // A non-zero exit on restore is logged but does NOT block the commit; the
    // restore is best-effort and the agent's edits still need to land.
    //
    // For staged deletions/renames (status letter in the index column), the
    // index no longer holds the old path — only HEAD does. `git checkout --`
    // restores from the index and would fail; `git checkout HEAD --` restores
    // from the commit and brings the file back into both the index and the
    // worktree.
    const naxPaths = parsePorcelainForNaxPaths(statusOutput);
    for (const { path: protectedPath, staged } of naxPaths) {
      // AC-17: this log is intentionally `error`-level even on a successful
      // restore — the deletion it is repairing indicates an agent mistake
      // worth surfacing loudly, not routine operation. A failed restore logs
      // again below with the exit code and stderr.
      logger?.error(stage, "Restoring deleted .nax/ path before auto-commit", {
        storyId,
        role,
        path: protectedPath,
        staged,
      });
      const checkoutArgs = staged
        ? ["git", "checkout", "HEAD", "--", protectedPath]
        : ["git", "checkout", "--", protectedPath];
      // Porcelain paths are repo-root-relative regardless of the cwd `git status`
      // ran from, so the restore must spawn from realGitRoot too — matching the
      // `git add -A` staging call below. Spawning from `workdir` (a monorepo
      // package subdir) makes the pathspec resolve against the wrong root and
      // the restore silently no-ops.
      const checkoutProc = _gitDeps.spawn(checkoutArgs, {
        cwd: realGitRoot,
        stdout: "pipe",
        stderr: "pipe",
      });
      const checkoutExit = await checkoutProc.exited;
      if (checkoutExit !== 0) {
        const stderr = await new Response(checkoutProc.stderr).text();
        logger?.error(stage, "Failed to restore .nax/ path before auto-commit", {
          storyId,
          role,
          path: protectedPath,
          exitCode: checkoutExit,
          stderr: stderr.trim(),
        });
      }
    }

    // Always stage from gitRoot with -A so that agent changes outside packageDir
    // (e.g. monorepo root package.json after `bun add`) are captured. Using
    // "git add . from workdir" misses those files, leaving them permanently dirty
    // and causing false-positive escalations in the review dirty-file check.
    const addProc = _gitDeps.spawn(["git", "add", "-A"], { cwd: realGitRoot, stdout: "pipe", stderr: "pipe" });
    await addProc.exited;

    const commitProc = _gitDeps.spawn(["git", "commit", "-m", `chore(${storyId}): auto-commit after ${role} session`], {
      cwd: workdir,
      stdout: "pipe",
      stderr: "pipe",
    });
    await commitProc.exited;
  } catch {
    // Silently ignore — auto-commit is best-effort
  }
}

/**
 * Capture files changed since a given git ref (for context chaining, ENH-005).
 * Scopes to scopePrefix (story.workdir) when set — prevents cross-package bleeding in monorepos.
 * Returns empty array if baseRef is falsy or git fails.
 */
export async function captureOutputFiles(
  workdir: string,
  baseRef: string | undefined,
  scopePrefix?: string,
): Promise<string[]> {
  if (!baseRef) return [];
  try {
    const args = ["diff", "--name-only", `${baseRef}..HEAD`];
    if (scopePrefix) args.push("--", `${scopePrefix}/`);
    const proc = _gitDeps.spawn(["git", ...args], { cwd: workdir, stdout: "pipe", stderr: "pipe" });
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    return output.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Capture ALL working-tree changes vs a pre-attempt git ref (US-003).
 * Unlike captureOutputFiles (committed range only), unions three sources:
 *   - baseRef..HEAD committed range
 *   - uncommitted tracked modifications vs HEAD
 *   - untracked files via ls-files --others --exclude-standard
 * All subprocesses run through gitWithTimeout at TIMEOUT_RETRY_GIT_TIMEOUT_MS
 * so a hung git cannot stall timeout-retry recovery (the agent has already
 * timed out), without shrinking the timeout for unrelated gitWithTimeout callers.
 * Returns empty array when baseRef is falsy or any subprocess fails.
 */
export async function captureWorkingTreeChanges(
  workdir: string,
  baseRef: string | undefined,
  scopePrefix?: string,
): Promise<string[]> {
  if (!baseRef) return [];

  const runDiff = async (args: string[]): Promise<string[]> => {
    const fullArgs = scopePrefix ? [...args, "--", `${scopePrefix}/`] : args;
    const { stdout, exitCode } = await gitWithTimeout(fullArgs, workdir, _gitDeps.timeoutRetryGitTimeoutMs);
    if (exitCode !== 0) return [];
    return stdout.trim().split("\n").filter(Boolean);
  };

  try {
    const [committed, uncommitted, untracked] = await Promise.all([
      runDiff(["diff", "--name-only", `${baseRef}..HEAD`]),
      runDiff(["diff", "--name-only", "HEAD"]),
      runDiff(["ls-files", "--others", "--exclude-standard"]),
    ]);
    const seen = new Set<string>();
    const merged: string[] = [];
    for (const list of [committed, uncommitted, untracked]) {
      for (const file of list) {
        if (!seen.has(file)) {
          seen.add(file);
          merged.push(file);
        }
      }
    }
    return merged;
  } catch {
    return [];
  }
}

/**
 * Capture a concise git diff stat summary for a completed story.
 *
 * Returns a formatted string like:
 *   src/plugins/extensions.ts | 120 +
 *   src/plugins/types.ts     |  24 +-
 *   2 files changed, 130 insertions(+), 14 deletions(-)
 *
 * Returns empty string on failure or when no baseRef is available.
 * Limited to ~30 lines to keep context token-friendly.
 */
export async function captureDiffSummary(
  workdir: string,
  baseRef: string | undefined,
  scopePrefix?: string,
): Promise<string> {
  if (!baseRef) return "";
  try {
    const args = ["diff", "--stat", `${baseRef}..HEAD`];
    if (scopePrefix) args.push("--", `${scopePrefix}/`);
    const proc = _gitDeps.spawn(["git", ...args], { cwd: workdir, stdout: "pipe", stderr: "pipe" });
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    const lines = output.trim().split("\n").filter(Boolean);
    // Cap at 30 lines to stay token-friendly
    if (lines.length > 30) {
      return [...lines.slice(0, 28), `... (${lines.length - 29} more files)`, lines[lines.length - 1]].join("\n");
    }
    return lines.join("\n");
  } catch {
    return "";
  }
}
