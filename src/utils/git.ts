/**
 * Git utility functions
 */

import { getSafeLogger } from "../logger";

/**
 * Injectable dependencies for git subprocess calls — allows tests to intercept
 * Bun.spawn without mock.module().
 *
 * @internal
 */
export const _gitDeps = { spawn: Bun.spawn };

/**
 * Default timeout for git subprocess calls.
 * Prevents git from hanging indefinitely on locked repos or network mounts.
 */
const GIT_TIMEOUT_MS = 10_000;

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
 * Git outputs "CONFLICT" in uppercase for merge/rebase conflicts.
 * Also checks lowercase "conflict" for edge cases.
 *
 * @param output - Combined stdout/stderr output from a git operation
 * @returns true if output contains CONFLICT markers
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
  return output.includes("CONFLICT") || output.includes("conflict");
}

/**
 * Auto-commit safety net.
 *
 * If the agent left uncommitted changes after a session, stage and commit them
 * automatically. Prevents the review stage from failing with "uncommitted
 * changes" errors. No-op when the working tree is clean.
 *
 * Used by session-runner.ts (TDD sessions), rectification-gate.ts, and
 * execution.ts (single-session / test-after).
 *
 * @param workdir - Working directory (git repo root)
 * @param stage   - Log stage prefix (e.g. "tdd", "execution")
 * @param role    - Session role for the commit message (e.g. "implementer")
 * @param storyId - Story ID for the commit message
 */
export async function autoCommitIfDirty(workdir: string, stage: string, role: string, storyId: string): Promise<void> {
  const logger = getSafeLogger();
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

    logger?.warn(stage, `Agent did not commit after ${role} session — auto-committing`, {
      role,
      storyId,
      dirtyFiles: statusOutput.trim().split("\n").length,
    });

    // Use "git add ." when workdir is a monorepo package subdir — only stages files under
    // that package, preventing accidental cross-package commits.
    // Use "git add -A" at repo root to capture renames/deletions across the full tree.
    const addArgs = isSubdir ? ["git", "add", "."] : ["git", "add", "-A"];
    const addProc = _gitDeps.spawn(addArgs, { cwd: workdir, stdout: "pipe", stderr: "pipe" });
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
