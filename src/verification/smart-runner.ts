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
/**
 * Extract searchable identifiers from a source file path.
 *
 * For `src/routing/strategies/llm.ts`, returns:
 *   ["/llm", "routing/strategies/llm"]
 *
 * @internal
 */
function extractSearchTerms(sourceFile: string): string[] {
  const withoutSrc = sourceFile.replace(/^src\//, "");
  const withoutExt = withoutSrc.replace(/\.ts$/, "");
  const parts = withoutExt.split("/");
  const basename = parts[parts.length - 1];
  // Use "/basename" to avoid matching short names as plain words
  return [`/${basename}`, withoutExt];
}

/**
 * Pass 2 — import-grep fallback.
 *
 * Scans test files matching `testFilePatterns` and returns those that
 * contain an import reference to any of the given `sourceFiles`.
 *
 * @param sourceFiles    - Changed source file paths (e.g. `["src/routing/strategies/llm.ts"]`)
 * @param workdir        - Absolute path to the repository root
 * @param testFilePatterns - Glob patterns to scan for test files
 * @returns Matching test file paths (absolute)
 */
export async function importGrepFallback(
  sourceFiles: string[],
  workdir: string,
  testFilePatterns: string[],
): Promise<string[]> {
  if (sourceFiles.length === 0 || testFilePatterns.length === 0) return [];

  // Collect search terms from all changed source files
  const searchTerms = sourceFiles.flatMap(extractSearchTerms);

  // Scan all test files matching the configured patterns
  const testFilePaths: string[] = [];
  for (const pattern of testFilePatterns) {
    const glob = new Bun.Glob(pattern);
    for await (const file of glob.scan(workdir)) {
      testFilePaths.push(`${workdir}/${file}`);
    }
  }

  // Return test files that contain any of the search terms
  const matched: string[] = [];
  for (const testFile of testFilePaths) {
    let content: string;
    try {
      content = await Bun.file(testFile).text();
    } catch {
      continue;
    }
    for (const term of searchTerms) {
      if (content.includes(term)) {
        matched.push(testFile);
        break;
      }
    }
  }

  return matched;
}

export async function mapSourceToTests(sourceFiles: string[], workdir: string): Promise<string[]> {
  const result: string[] = [];

  for (const sourceFile of sourceFiles) {
    // Strip leading "src/" and replace ".ts" with ".test.ts"
    const relative = sourceFile.replace(/^src\//, "").replace(/\.ts$/, ".test.ts");

    const candidates = [`${workdir}/test/unit/${relative}`, `${workdir}/test/integration/${relative}`];

    for (const candidate of candidates) {
      if (await Bun.file(candidate).exists()) {
        result.push(candidate);
      }
    }
  }

  return result;
}

/**
 * Build a scoped test command targeting specific test files.
 *
 * When `testFiles` is non-empty, replaces the last path-like argument in
 * `baseCommand` (a token containing `/`) with the specific test file paths
 * joined by spaces. If no path argument is found, appends the test files.
 *
 * When `testFiles` is empty, returns `baseCommand` unchanged (full-suite
 * fallback).
 *
 * @param testFiles   - Test file paths to scope the run to
 * @param baseCommand - Full test command (e.g. `"bun test test/"`)
 * @returns Scoped command string
 *
 * @example
 * ```typescript
 * buildSmartTestCommand(["test/unit/foo.test.ts"], "bun test test/")
 * // => "bun test test/unit/foo.test.ts"
 *
 * buildSmartTestCommand([], "bun test test/")
 * // => "bun test test/"
 * ```
 */
export function buildSmartTestCommand(testFiles: string[], baseCommand: string): string {
  if (testFiles.length === 0) {
    return baseCommand;
  }

  const parts = baseCommand.trim().split(/\s+/);

  // Find the last token that looks like a path (contains '/')
  let lastPathIndex = -1;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].includes("/")) {
      lastPathIndex = i;
      break;
    }
  }

  if (lastPathIndex === -1) {
    // No path argument — append test files
    return `${baseCommand} ${testFiles.join(" ")}`;
  }

  // Replace the last path argument with the specific test files
  const newParts = [...parts.slice(0, lastPathIndex), ...testFiles];
  return newParts.join(" ");
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

/**
 * Map test files back to their corresponding source files.
 *
 * For each test file path, converts it back to the likely source file path.
 * Handles both `test/unit/` and `test/integration/` conventions.
 * Only processes .test.ts files (not .test.js).
 *
 * @param testFiles - Array of test file paths (e.g. `["/repo/test/unit/foo/bar.test.ts"]`)
 * @param workdir - Absolute path to the repository root (to normalize paths)
 * @returns Source file paths (e.g. `["src/foo/bar.ts"]`)
 *
 * @example
 * ```typescript
 * const sources = reverseMapTestToSource(["/repo/test/unit/foo/bar.test.ts"], "/repo");
 * // Returns: ["src/foo/bar.ts"]
 * ```
 */
export function reverseMapTestToSource(testFiles: string[], workdir: string): string[] {
  const result: string[] = [];
  const seenPaths = new Set<string>();

  for (const testFile of testFiles) {
    // Only process .test.ts files
    if (!testFile.endsWith(".test.ts")) {
      continue;
    }

    // Normalize the path to be relative to workdir
    let relativePath = testFile.startsWith(workdir) ? testFile.slice(workdir.length + 1) : testFile;

    // Remove test/unit/ or test/integration/ prefix
    if (relativePath.startsWith("test/unit/")) {
      relativePath = relativePath.slice("test/unit/".length);
    } else if (relativePath.startsWith("test/integration/")) {
      relativePath = relativePath.slice("test/integration/".length);
    } else {
      continue; // Not a recognized test file pattern
    }

    // Replace .test.ts with .ts and add src/ prefix
    const sourcePath = "src/" + relativePath.replace(/\.test\.ts$/, ".ts");

    if (!seenPaths.has(sourcePath)) {
      result.push(sourcePath);
      seenPaths.add(sourcePath);
    }
  }

  return result;
}

/**
 * Injectable dependencies for testing.
 * Allows tests to swap implementations without using mock.module(),
 * which leaks across files in Bun 1.x due to shared module registry.
 *
 * @internal - test use only. Do not use in production code.
 */
export const _smartRunnerDeps = {
  getChangedSourceFiles,
  mapSourceToTests,
  importGrepFallback,
  buildSmartTestCommand,
  reverseMapTestToSource,
};
