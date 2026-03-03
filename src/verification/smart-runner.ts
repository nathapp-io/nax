/**
 * Smart Runner — Git diff file detection
 *
 * Detects changed TypeScript source files using git diff,
 * enabling targeted test runs on only the files that changed.
 */

/**
 * Get TypeScript source files changed since the previous commit.
 *
 * Runs `git diff --name-only HEAD~1` in the given workdir and filters
 * results to only `.ts` files under `src/`. Returns an empty array on
 * any git error (not a repo, no previous commit, etc.).
 *
 * @param workdir - Working directory to run git command in
 * @returns Array of changed .ts file paths relative to the repo root
 *
 * @example
 * ```typescript
 * const files = await getChangedSourceFiles("/path/to/repo");
 * // Returns: ["src/foo/bar.ts", "src/utils/git.ts"]
 * ```
 */
export async function getChangedSourceFiles(workdir: string): Promise<string[]> {
  try {
    const proc = Bun.spawn({
      cmd: ["git", "diff", "--name-only", "HEAD~1"],
      cwd: workdir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    if (exitCode !== 0) return [];

    const stdout = await new Response(proc.stdout).text();
    const lines = stdout.trim().split("\n").filter(Boolean);

    return lines.filter((f) => f.startsWith("src/") && f.endsWith(".ts"));
  } catch {
    return [];
  }
}
