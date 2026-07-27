/**
 * Git utility functions
 */

import { getSafeLogger } from "../logger";
import { spawn } from "./bun-deps";

/**
 * Injectable dependencies for git subprocess calls — allows tests to intercept
 * Bun.spawn without mock.module().
 *
 * @internal
 */
export const _gitDeps = { spawn, getSafeLogger };

/**
 * Default timeout for git subprocess calls.
 * Prevents git from hanging indefinitely on locked repos or network mounts.
 * Local git operations (status, diff, ls-files) complete in well under 1s on
 * typical repos; 3s is a generous upper bound that still bounds timeout-retry
 * recovery within the bun:test global timeout window.
 */
const GIT_TIMEOUT_MS = 3_000;

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
export async function gitWithTimeout(args: string[], workdir: string): Promise<{ stdout: string; exitCode: number }> {
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
  }, GIT_TIMEOUT_MS);

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
 */
export async function autoCommitIfDirty(workdir: string, stage: string, role: string, storyId: string): Promise<void> {
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
 * All subprocesses run through gitWithTimeout so a hung git cannot stall
 * timeout-retry recovery (the agent has already timed out).
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
    const { stdout, exitCode } = await gitWithTimeout(fullArgs, workdir);
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
