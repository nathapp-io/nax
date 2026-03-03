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
/**
 * Map source files to their corresponding test files.
 *
 * For each file in `sourceFiles`, checks both:
 *   - `<workdir>/test/unit/<relative-path>.test.ts`
 *   - `<workdir>/test/integration/<relative-path>.test.ts`
 *
 * where `<relative-path>` is the file path with the leading `src/` stripped
 * and the `.ts` extension replaced with `.test.ts`.
 *
 * Only returns paths that actually exist on disk.
 *
 * @param sourceFiles - Array of source file paths (e.g. `["src/foo/bar.ts"]`)
 * @param workdir     - Absolute path to the repository root
 * @returns Existing test file paths (absolute)
 *
 * @example
 * ```typescript
 * const tests = await mapSourceToTests(["src/foo/bar.ts"], "/repo");
 * // Returns: ["/repo/test/unit/foo/bar.test.ts"] (if it exists)
 * ```
 */
export async function mapSourceToTests(sourceFiles: string[], workdir: string): Promise<string[]> {
  const result: string[] = [];

  for (const sourceFile of sourceFiles) {
    // Strip leading "src/" and replace ".ts" with ".test.ts"
    const relative = sourceFile.replace(/^src\//, "").replace(/\.ts$/, ".test.ts");

    const candidates = [
      `${workdir}/test/unit/${relative}`,
      `${workdir}/test/integration/${relative}`,
    ];

    for (const candidate of candidates) {
      if (await Bun.file(candidate).exists()) {
        result.push(candidate);
      }
    }
  }

  return result;
}

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
