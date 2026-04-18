/**
 * Test File Conventions — single source of truth for test-file patterns.
 *
 * The smart test runner, config schema, and TDD orchestrator all need to
 * answer some variation of "what does a test file look like?". Historically
 * this concept was duplicated across 7 source files in three different
 * representations (glob strings, regex lists, ad-hoc regexes). This module
 * consolidates the glob form and provides a derivation utility for
 * subsystems that need regex-based classification.
 *
 * See issue #461 for the follow-up work (auto-detection + config propagation
 * through `isTestFile()` and the TDD orchestrator).
 */

/**
 * Canonical default glob patterns for test-file discovery.
 *
 * Used by:
 * - `SmartTestRunnerConfigSchema` as the Zod default
 * - `mapSourceToTests()` and `importGrepFallback()` as the fallback
 * - `verify` and `scoped` stages as their in-memory default
 *
 * Users override via `execution.smartTestRunner.testFilePatterns` in
 * `.nax/config.json`. The suffix after the last `*` in each glob drives
 * language-agnostic co-located test discovery (see `extractPatternSuffix`
 * in `smart-runner.ts`).
 */
export const DEFAULT_TEST_FILE_PATTERNS: readonly string[] = Object.freeze(["test/**/*.test.ts"]);

/**
 * Convert a single glob pattern into a path-classifying regex.
 *
 * Translates standard glob syntax to regex:
 * - `**` (with optional surrounding `/`) → `(?:.*\/)?` (any number of path segments)
 * - `*` → `[^/]*` (any chars except path separator)
 * - `.` → `\.`
 * - All other regex-special chars escaped
 *
 * The resulting regex is anchored to the end of the path with `$` and to a
 * path-segment boundary at the start (so `**\/__tests__/...` matches paths
 * containing a `__tests__` segment, not paths where it appears mid-segment).
 *
 * Returns null when the glob would compile to something that matches everything
 * (e.g. the empty string or just `**`), to avoid silently classifying every
 * path as a test file.
 *
 * @internal
 */
function globToRegex(pattern: string): RegExp | null {
  if (pattern.length === 0) return null;
  if (/^\*+\/?$/.test(pattern)) return null;

  let regex = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      // `**/` or `/**` or `**` → match any number of path segments (including zero)
      if (pattern[i + 1] === "*") {
        const beforeSlash = i > 0 && pattern[i - 1] === "/";
        const afterSlash = pattern[i + 2] === "/";
        if (beforeSlash && afterSlash) {
          regex = `${regex.slice(0, -1)}(?:.*\\/)?`;
          i += 3;
        } else if (afterSlash) {
          regex += "(?:.*\\/)?";
          i += 3;
        } else {
          regex += ".*";
          i += 2;
        }
        continue;
      }
      regex += "[^/]*";
      i++;
      continue;
    }
    if (c === "?") {
      regex += "[^/]";
      i++;
      continue;
    }
    if (".+^${}()|[]\\".includes(c)) {
      regex += `\\${c}`;
    } else {
      regex += c;
    }
    i++;
  }

  // Anchor to end of path; allow leading match anywhere along path-segment boundary
  // so `__tests__/foo.ts` and `apps/api/__tests__/foo.ts` both classify as tests.
  return new RegExp(`(?:^|/)${regex}$`);
}

/**
 * Derive path-classification regexes from a list of glob patterns.
 *
 * Each returned regex matches paths matching its source glob — preserving
 * directory structure, not just trailing suffix. Patterns that compile to
 * a "match everything" regex (e.g. lone `**`) are silently skipped.
 * Duplicate regexes are de-duplicated by source.
 *
 * @example
 * globsToTestRegex(["test/**\/*.test.ts", "src/**\/*.spec.ts"])
 * // → regexes that match e.g. "test/foo.test.ts" and "src/util/foo.spec.ts"
 *
 * @example
 * globsToTestRegex(["**\/__tests__/**\/*.ts"])
 * // → regex that matches "src/__tests__/foo.ts" but NOT "src/foo.ts"
 */
export function globsToTestRegex(patterns: readonly string[]): RegExp[] {
  const regexes: RegExp[] = [];
  const seen = new Set<string>();
  for (const pattern of patterns) {
    const re = globToRegex(pattern);
    if (re && !seen.has(re.source)) {
      regexes.push(re);
      seen.add(re.source);
    }
  }
  return regexes;
}

/**
 * Classify a path as a test file using the given glob patterns.
 *
 * Thin wrapper around `globsToTestRegex()` for callers that just need a
 * boolean answer. Returns false when `patterns` yields no usable regexes.
 */
export function isTestFileByPatterns(filePath: string, patterns: readonly string[]): boolean {
  const regexes = globsToTestRegex(patterns);
  return regexes.some((re) => re.test(filePath));
}

/**
 * Convert a list of glob patterns to git pathspec exclusions.
 *
 * Extracts the last meaningful path segment (suffix) from each glob and
 * prepends `:!` to form a git pathspec exclusion. Patterns with no
 * extractable suffix or with only wildcard suffixes are skipped.
 * Duplicate exclusions are de-duplicated by source.
 *
 * @example
 * globsToPathspec(["test\/**\/*.test.ts", "**\/*.spec.ts"])
 * // → [":!*.test.ts", ":!*.spec.ts"]
 *
 * @example
 * globsToPathspec(["**\/*_test.go"])
 * // → [":!*_test.go"]
 */
export function globsToPathspec(patterns: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const pattern of patterns) {
    const lastStar = pattern.lastIndexOf("*");
    if (lastStar === -1) continue;
    const suffix = pattern.slice(lastStar + 1);
    if (suffix.length === 0) continue;
    const pathspec = `:!*${suffix}`;
    if (!seen.has(pathspec)) {
      result.push(pathspec);
      seen.add(pathspec);
    }
  }
  return result;
}

/**
 * Extract leading directory names from glob patterns.
 *
 * Returns the first path segment of each glob when it is a literal
 * directory name (not a wildcard). Wildcards and patterns that start
 * with `**` produce no directory entry.
 *
 * @example
 * extractTestDirs(["test\/**\/*.test.ts", "src\/**\/*.spec.ts"])
 * // → ["test"]
 *
 * @example
 * extractTestDirs(["**\/*.test.ts"])
 * // → []
 */
export function extractTestDirs(globs: readonly string[]): string[] {
  const dirs = new Set<string>();
  for (const glob of globs) {
    const firstSegment = glob.split("/")[0];
    if (firstSegment && !firstSegment.includes("*") && firstSegment.length > 0) {
      dirs.add(firstSegment);
    }
  }
  return [...dirs];
}

/** Candidate test directory roots for heuristic detection when no resolver patterns are available */
export const DEFAULT_SCAN_TEST_DIRS: readonly string[] = Object.freeze([
  "test",
  "tests",
  "__tests__",
  "src/__tests__",
  "spec",
]);

/** Default TS/JS test file suffixes used when glob resolver yields no patterns */
export const DEFAULT_TS_DERIVE_SUFFIXES: readonly string[] = Object.freeze([
  ".test.ts",
  ".test.js",
  ".test.tsx",
  ".test.jsx",
  ".spec.ts",
  ".spec.js",
  ".spec.tsx",
  ".spec.jsx",
]);

/** Separated test subdirectory paths probed by mapSourceToTests (pass-1 discovery) */
export const DEFAULT_SEPARATED_TEST_DIRS: readonly string[] = Object.freeze(["test/unit", "test/integration"]);
