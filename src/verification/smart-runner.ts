/**
 * Smart Runner — Git diff file detection
 *
 * Detects changed TypeScript source files using git diff,
 * enabling targeted test runs on only the files that changed.
 */
import { DEFAULT_SEPARATED_TEST_DIRS, DEFAULT_TEST_FILE_PATTERNS } from "../test-runners/conventions";
import { gitWithTimeout } from "../utils/git";

/**
 * Bun API wrappers — defined before functions to avoid circular type inference.
 * Use closures so tests mocking Bun.Glob / Bun.file on the global namespace
 * continue to work (closures evaluate Bun.* at call time).
 *
 * @internal
 */
const _bunDeps = {
  glob: (p: string) => new Bun.Glob(p),
  file: (path: string) => Bun.file(path),
};

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
 * Checks four candidate locations per source file (in order):
 *
 * 1. Separated test directory — `<testBase>/test/unit/<relative>.test.ts`
 * 2. Separated test directory — `<testBase>/test/integration/<relative>.test.ts`
 * 3. Co-located spec file    — `<workdir>/<sourceFile>.spec.ts`  (NestJS convention)
 * 4. Co-located test file    — `<workdir>/<sourceFile>.test.ts`  (Vitest/Jest convention)
 *
 * `<testBase>` is `workdir` for single-package repos and `workdir/<packagePrefix>`
 * for monorepo packages. Co-located candidates always resolve relative to the git root.
 *
 * Only returns paths that actually exist on disk.
 *
 * @param sourceFiles   - Source file paths relative to the git root (e.g. `["src/foo/bar.ts"]`)
 * @param workdir       - Absolute path to the repository root
 * @param packagePrefix - Monorepo package directory relative to repo root (e.g. `"apps/api"`)
 * @returns Existing test file paths (absolute)
 *
 * @example
 * ```typescript
 * // Single-package, separated
 * await mapSourceToTests(["src/foo/bar.ts"], "/repo");
 * // => ["/repo/test/unit/foo/bar.test.ts"]
 *
 * // Monorepo, separated
 * await mapSourceToTests(["apps/api/src/foo/bar.ts"], "/repo", "apps/api");
 * // => ["/repo/apps/api/test/unit/foo/bar.test.ts"]
 *
 * // Monorepo, co-located .spec.ts (NestJS)
 * await mapSourceToTests(["apps/api/src/agents/agents.service.ts"], "/repo", "apps/api");
 * // => ["/repo/apps/api/src/agents/agents.service.spec.ts"]
 * ```
 */
/**
 * Extract the test-file suffix implied by a glob pattern.
 *
 * The suffix is everything that follows the last `*` wildcard, making this
 * language-agnostic: the caller's `testFilePatterns` configuration drives which
 * suffixes are probed rather than hardcoding TypeScript-specific extensions.
 *
 * @example
 * extractPatternSuffix("test/**\/*.test.ts")  // ".test.ts"
 * extractPatternSuffix("src/**\/*.spec.ts")   // ".spec.ts"
 * extractPatternSuffix("**\/*_test.go")       // "_test.go"
 *
 * @internal
 */
function extractPatternSuffix(pattern: string): string | null {
  const lastStar = pattern.lastIndexOf("*");
  if (lastStar === -1) return null;
  const suffix = pattern.slice(lastStar + 1);
  return suffix.length > 0 ? suffix : null;
}

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
    const glob = _bunDeps.glob(pattern);
    for await (const file of glob.scan(workdir)) {
      testFilePaths.push(`${workdir}/${file}`);
    }
  }

  // Return test files that contain any of the search terms
  const matched: string[] = [];
  for (const testFile of testFilePaths) {
    let content: string;
    try {
      content = await _bunDeps.file(testFile).text();
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

export async function mapSourceToTests(
  sourceFiles: string[],
  workdir: string,
  packagePrefix?: string,
  testFilePatterns: string[] = [...DEFAULT_TEST_FILE_PATTERNS],
): Promise<string[]> {
  // Derive unique test-file suffixes from configured patterns — language-agnostic.
  // e.g. ["test/**/*.test.ts", "src/**/*.spec.ts"] → [".test.ts", ".spec.ts"]
  // e.g. ["**/*_test.go"] → ["_test.go"]
  const testSuffixes = [...new Set(testFilePatterns.map(extractPatternSuffix).filter((s): s is string => s !== null))];

  const result: string[] = [];

  for (const sourceFile of sourceFiles) {
    // Strip source extension for co-located candidate generation
    const sourceWithoutExt = sourceFile.replace(/\.[^.]+$/, "");

    let innerRelative: string;
    let testBase: string;

    if (packagePrefix) {
      // Monorepo: source path is "<prefix>/src/foo.ts" — strip "<prefix>/src/" to get "foo"
      const srcRoot = `${packagePrefix}/src/`;
      const inner = sourceFile.startsWith(srcRoot)
        ? sourceFile.slice(srcRoot.length)
        : sourceFile.replace(/^.*\/src\//, "");
      innerRelative = inner.replace(/\.[^.]+$/, "");
      testBase = `${workdir}/${packagePrefix}`;
    } else {
      // Single-package: source path is "src/foo.ts" — strip "src/" and extension
      innerRelative = sourceFile.replace(/^src\//, "").replace(/\.[^.]+$/, "");
      testBase = workdir;
    }

    const candidates: string[] = [];

    for (const suffix of testSuffixes) {
      // Separated test directories (driven by SSOT — see conventions.ts)
      for (const testDir of DEFAULT_SEPARATED_TEST_DIRS) {
        candidates.push(`${testBase}/${testDir}/${innerRelative}${suffix}`);
      }
      // Co-located: next to the source file (e.g. NestJS .spec.ts, Vitest .test.ts, Go _test.go)
      candidates.push(`${workdir}/${sourceWithoutExt}${suffix}`);
    }

    for (const candidate of candidates) {
      if (await _bunDeps.file(candidate).exists()) {
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

  // Replace the last path argument with the specific test files,
  // preserving any flags that appear after the path (e.g. --timeout=60000).
  const beforePath = parts.slice(0, lastPathIndex);
  const afterPath = parts.slice(lastPathIndex + 1);
  const newParts = [...beforePath, ...testFiles, ...afterPath];
  return newParts.join(" ");
}

/**
 * Get TypeScript source files changed since the previous commit.
 *
 * Runs `git diff --name-only <ref>` in the given workdir and filters
 * results to only `.ts` files under the relevant source prefix.
 *
 * In a monorepo, git returns paths relative to the git root (e.g.
 * `packages/api/src/foo.ts`). When `packagePrefix` is set to the
 * story's workdir (e.g. `"packages/api"`), the filter is scoped to
 * `<packagePrefix>/src/` instead of just `src/`.
 *
 * @param workdir       - Working directory to run git command in
 * @param baseRef       - Git ref for diff base (default: HEAD~1)
 * @param packagePrefix - Story workdir relative to repo root (e.g. "packages/api")
 * @returns Array of changed .ts file paths relative to the git root
 */
export async function getChangedSourceFiles(
  workdir: string,
  baseRef?: string,
  packagePrefix?: string,
): Promise<string[]> {
  try {
    // FEAT-010: Use per-attempt baseRef for precise diff; fall back to HEAD~1 if not provided
    const ref = baseRef ?? "HEAD~1";
    // BUG-039: Use gitWithTimeout to prevent orphan processes on hang
    const { stdout, exitCode } = await gitWithTimeout(["diff", "--name-only", ref], workdir);
    if (exitCode !== 0) return [];

    const lines = stdout.trim().split("\n").filter(Boolean);

    // MW-006: scope filter to package prefix in monorepo
    const srcPrefix = packagePrefix ? `${packagePrefix}/src/` : "src/";
    return lines.filter((f) => f.startsWith(srcPrefix) && f.endsWith(".ts"));
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

    // Remove separated test dir prefix (driven by SSOT — see conventions.ts)
    let stripped = false;
    for (const testDir of DEFAULT_SEPARATED_TEST_DIRS) {
      if (relativePath.startsWith(`${testDir}/`)) {
        relativePath = relativePath.slice(`${testDir}/`.length);
        stripped = true;
        break;
      }
    }
    if (!stripped) continue;

    // Replace .test.ts with .ts and add src/ prefix
    const sourcePath = `src/${relativePath.replace(/\.test\.ts$/, ".ts")}`;

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
 * Bun API wrappers use closures so that tests mocking Bun.Glob / Bun.file
 * on the global namespace continue to work (closures evaluate Bun.* at
 * call time, not at module initialisation time).
 *
 * @internal - test use only. Do not use in production code.
 */
export const _smartRunnerDeps = {
  /** Wraps Bun.Glob construction — injectable for testing. */
  glob: _bunDeps.glob,
  /** Wraps Bun.file — injectable for testing. */
  file: _bunDeps.file,
  getChangedSourceFiles,
  mapSourceToTests,
  importGrepFallback,
  buildSmartTestCommand,
  reverseMapTestToSource,
};
