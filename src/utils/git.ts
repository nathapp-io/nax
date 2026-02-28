/**
 * Git utility functions
 */

import { spawn } from "bun";

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
    const proc = spawn({
      cmd: ["git", "rev-parse", "HEAD"],
      cwd: workdir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    if (exitCode !== 0) return undefined;

    const stdout = await new Response(proc.stdout).text();
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Check if a story ID appears in recent git commit messages.
 *
 * Searches the last 20 commits for commit messages containing the story ID.
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
    const proc = spawn({
      cmd: ["git", "log", `-${maxCommits}`, "--oneline", "--grep", storyId],
      cwd: workdir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    if (exitCode !== 0) return false;

    const stdout = await new Response(proc.stdout).text();
    const commits = stdout.trim();

    // If any commits found, return true
    return commits.length > 0;
  } catch {
    return false;
  }
}
