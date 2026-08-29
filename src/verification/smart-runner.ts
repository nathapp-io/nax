/**
 * Smart Runner — Git diff file detection
 *
 * Smart-runner resolves scope in ordered passes:
 * 1. changed test files run directly
 * 2. changed non-test files map to likely tests by path convention
 * 3. changed non-test files fall back to import/content grep
 *
 * The key input is "changed non-test files", not "TypeScript source files".
 * Smart-runner has to work across package layouts and languages, so only test
 * classification is hard-filtered here. Everything else stays generic.
 */
import { join, relative } from "node:path";
import { getSafeLogger } from "../logger";
import { DEFAULT_SEPARATED_TEST_DIRS, DEFAULT_TEST_FILE_PATTERNS, extractTestDirs } from "../test-runners/conventions";
import { errorMessage } from "../utils/errors";
import { getGitRoot, gitWithTimeout } from "../utils/git";
import { filterNaxInternalPaths, type NaxIgnoreIndex, resolveNaxIgnorePatterns } from "../utils/path-filters";

/**
 * Bun API wrappers — defined before functions to avoid circular type inference.
 * Use closures so tests mocking Bun.Glob / Bun.file on the global namespace
 * continue to work (closures evaluate Bun.* at call time).
 *
 * @internal
 */
export const _bunDeps = {
  glob: (p: string) => new Bun.Glob(p),
  file: (path: string) => Bun.file(path),
};

/** Cap on test files scanned by the import-grep fallback. */
export const MAX_GREP_TEST_FILES = 200;

/**
 * Injectable git utilities — defined before functions so getChangedTestFiles and
 * getChangedNonTestFiles can reference _gitUtilDeps.getGitRoot without a forward
 * reference. Tests override this to avoid a real git spawn call.
 *
 * @internal
 */
export const _gitUtilDeps = {
  getGitRoot,
  gitWithTimeout,
};

/** Per-process memo: workdir → resolved git root. Cleared at run end via clearGitRootCache(). */
const _gitRootCache = new Map<string, string>();

/**
 * Clear the git-root memo cache.
 * Called by run-completion.ts to reset state between runs in the same process.
 */
export function clearGitRootCache(): void {
  _gitRootCache.clear();
}

/** Memoized git-root resolver — delegates to the injectable _gitUtilDeps.getGitRoot. */
async function getGitRootMemo(workdir: string): Promise<string | null> {
  const cached = _gitRootCache.get(workdir);
  if (cached !== undefined) return cached;
  const result = await _gitUtilDeps.getGitRoot(workdir);
  if (result !== null && result !== undefined) {
    _gitRootCache.set(workdir, result);
  }
  return result ?? null;
}

/**
 * Test-file basename shape implied by a glob pattern: `<prefix>*<suffix>`.
 *
 * Derived from the glob's basename segment so both suffix conventions
 * (`*.test.ts`, `*_test.go`) and prefix conventions (pytest's `test_*.py`)
 * are representable. Language-agnostic: the caller's `testFilePatterns`
 * configuration drives which shapes are probed.
 *
 * @internal
 */
interface BasenamePattern {
  prefix: string;
  suffix: string;
}

/**
 * Extract the test-file basename shape implied by a glob pattern.
 *
 * Looks only at the basename segment (after the last `/`) and requires exactly
 * one `*` wildcard in it, splitting into prefix + suffix.
 *
 * @remarks Only single-wildcard basenames are representable — patterns like
 * `*spec*.ts` return null and contribute no Pass-1 candidate (Pass 2
 * import-grep still covers files matching them).
 *
 * @example
 * extractBasenamePattern("test/**\/*.test.ts")   // { prefix: "",      suffix: ".test.ts" }
 * extractBasenamePattern("tests/**\/test_*.py")  // { prefix: "test_", suffix: ".py" }
 * extractBasenamePattern("**\/*_test.go")        // { prefix: "",      suffix: "_test.go" }
 *
 * @internal
 */
function extractBasenamePattern(pattern: string): BasenamePattern | null {
  const basename = pattern.slice(pattern.lastIndexOf("/") + 1);
  const parts = basename.split("*");
  if (parts.length !== 2) return null;
  const [prefix, suffix] = parts;
  if (!prefix && !suffix) return null;
  return { prefix, suffix };
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
  const withoutPrefix = sourceFile.replace(/^(?:.*\/)?src\//, "");
  const withoutExt = withoutPrefix.replace(/\.[^.]+$/, "");
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
  maxScanFiles: number = MAX_GREP_TEST_FILES,
): Promise<string[]> {
  if (sourceFiles.length === 0 || testFilePatterns.length === 0) return [];

  // Collect search terms from all changed source files
  const searchTerms = sourceFiles.flatMap(extractSearchTerms);

  // Scan all test files matching the configured patterns, capped at maxScanFiles
  // (config.execution.smartTestRunner.maxScanFiles; defaults to MAX_GREP_TEST_FILES).
  const testFilePaths: string[] = [];
  outer: for (const pattern of testFilePatterns) {
    const g = _bunDeps.glob(pattern);
    for await (const file of g.scan({ cwd: workdir, absolute: false })) {
      testFilePaths.push(`${workdir}/${file}`);
      if (testFilePaths.length >= maxScanFiles) {
        getSafeLogger()?.debug("smart-runner", "import-grep glob cap reached — results truncated", {
          cap: maxScanFiles,
        });
        break outer;
      }
    }
  }

  // Read all collected files concurrently and filter to those containing any search term
  const results = await Promise.all(
    testFilePaths.map(async (testFile) => {
      try {
        const content = await _bunDeps.file(testFile).text();
        return searchTerms.some((t) => content.includes(t)) ? testFile : null;
      } catch {
        return null;
      }
    }),
  );
  return results.filter((p): p is string => p !== null);
}

/**
 * Map source files to their corresponding test files (Pass 1 — path convention).
 *
 * Per source file, probes candidates built from the configured patterns'
 * basename shapes (see {@link buildTestCandidates}): mirrored under separated
 * test dirs (SSOT defaults + dirs declared by the patterns), flat for prefix
 * shapes, and co-located next to the source. The source file itself is never
 * a candidate. Only returns paths that actually exist on disk.
 *
 * `<testBase>` is `workdir` for single-package repos and `workdir/<packagePrefix>`
 * for monorepo packages. Co-located candidates always resolve relative to the git root.
 *
 * @param sourceFiles      - Source file paths relative to the git root (e.g. `["src/foo/bar.ts"]`)
 * @param workdir          - Absolute path to the repository root
 * @param packagePrefix    - Monorepo package directory relative to repo root (e.g. `"apps/api"`)
 * @param testFilePatterns - Glob patterns classifying test files (config-driven)
 * @returns Existing test file paths (absolute)
 *
 * @example
 * ```typescript
 * // Single-package, separated (suffix convention)
 * await mapSourceToTests(["src/foo/bar.ts"], "/repo");
 * // => ["/repo/test/unit/foo/bar.test.ts"]
 *
 * // Monorepo, co-located .spec.ts (NestJS)
 * await mapSourceToTests(["apps/api/src/agents/agents.service.ts"], "/repo", "apps/api");
 * // => ["/repo/apps/api/src/agents/agents.service.spec.ts"]
 *
 * // Monorepo, pytest prefix convention
 * await mapSourceToTests(["apps/api/src/pkg/sizing.py"], "/repo", "apps/api", ["tests/**\/test_*.py"]);
 * // => ["/repo/apps/api/tests/pkg/test_sizing.py"]
 * ```
 */
export async function mapSourceToTests(
  sourceFiles: string[],
  workdir: string,
  packagePrefix?: string,
  testFilePatterns: string[] = [...DEFAULT_TEST_FILE_PATTERNS],
): Promise<string[]> {
  // Derive unique basename shapes from configured patterns — language-agnostic.
  // e.g. ["test/**/*.test.ts"] → [{prefix:"", suffix:".test.ts"}]
  // e.g. ["tests/**/test_*.py"] → [{prefix:"test_", suffix:".py"}]
  const shapes = dedupeBasenamePatterns(testFilePatterns);
  // Probe separated dirs from the SSOT default PLUS any static leading dir the
  // patterns themselves declare (e.g. "tests/**/*.py" → "tests").
  const testDirs = [...new Set([...DEFAULT_SEPARATED_TEST_DIRS, ...extractTestDirs(testFilePatterns)])];

  const result: string[] = [];

  for (const sourceFile of sourceFiles) {
    const candidates = buildTestCandidates(sourceFile, workdir, packagePrefix, shapes, testDirs);
    const existsFlags = await Promise.all(candidates.map((c) => _bunDeps.file(c).exists()));
    candidates.forEach((c, i) => {
      if (existsFlags[i]) result.push(c);
    });
  }

  return result;
}

/** @internal Dedupe basename shapes by prefix+suffix identity. */
function dedupeBasenamePatterns(testFilePatterns: readonly string[]): BasenamePattern[] {
  const seen = new Set<string>();
  const shapes: BasenamePattern[] = [];
  for (const pattern of testFilePatterns) {
    const shape = extractBasenamePattern(pattern);
    if (!shape) continue;
    const key = `${shape.prefix}\u0000${shape.suffix}`;
    if (seen.has(key)) continue;
    seen.add(key);
    shapes.push(shape);
  }
  return shapes;
}

/**
 * Build candidate test-file paths for one source file.
 *
 * Suffix shapes (prefix === "") probe the historical layout: mirrored under
 * each test dir + co-located next to the source. Prefix shapes (pytest's
 * `test_*.py`) probe mirrored, flat, and co-located with the prefixed basename.
 *
 * Identity guard (#1207): a suffix shape whose suffix equals the source
 * extension (e.g. ".py" from "tests/**\/*.py") reconstructs the source file
 * itself as its co-located candidate — pytest would then "run" a non-test
 * source file. The source path is always excluded.
 *
 * @internal
 */
function buildTestCandidates(
  sourceFile: string,
  workdir: string,
  packagePrefix: string | undefined,
  shapes: readonly BasenamePattern[],
  testDirs: readonly string[],
): string[] {
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

  const lastSlash = innerRelative.lastIndexOf("/");
  const innerDir = lastSlash === -1 ? "" : innerRelative.slice(0, lastSlash);
  const baseName = lastSlash === -1 ? innerRelative : innerRelative.slice(lastSlash + 1);
  const sourceDirAbs = sourceWithoutExt.includes("/")
    ? `${workdir}/${sourceWithoutExt.slice(0, sourceWithoutExt.lastIndexOf("/"))}`
    : workdir;

  const candidates: string[] = [];
  for (const { prefix, suffix } of shapes) {
    if (prefix === "") {
      // Suffix convention — mirrored under each test dir (driven by SSOT — see conventions.ts)
      for (const testDir of testDirs) {
        candidates.push(`${testBase}/${testDir}/${innerRelative}${suffix}`);
      }
      // Co-located: next to the source file (e.g. NestJS .spec.ts, Vitest .test.ts, Go _test.go)
      candidates.push(`${workdir}/${sourceWithoutExt}${suffix}`);
    } else {
      // Prefix convention (pytest test_*.py) — prefixed basename, mirrored + flat + co-located
      const named = `${prefix}${baseName}${suffix}`;
      for (const testDir of testDirs) {
        candidates.push(`${testBase}/${testDir}/${innerDir ? `${innerDir}/` : ""}${named}`);
        if (innerDir) candidates.push(`${testBase}/${testDir}/${named}`);
      }
      candidates.push(`${sourceDirAbs}/${named}`);
    }
  }

  const sourceAbs = `${workdir}/${sourceFile}`;
  return [...new Set(candidates)].filter((c) => c !== sourceAbs);
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
// BUG-18/ENH-2: flags that take a path argument. A token immediately following one
// of these (or a `--flag=<path>` combined form) is a flag's config path, not a
// positional test-path argument, and must never be replaced by scoped test
// files — doing so silently drops the flag's value (e.g. `--config
// ./vitest.config.ts` -> `--config '<test files>'`). ENH-2: pnpm/turbo/nx
// monorepo scoping flags (`--filter`, `--dir`, `-F`) were missing, silently
// breaking scoped runs like `pnpm --filter ./packages/api test`.
const PATH_TAKING_FLAGS = ["--config", "-c", "--project", "-p", "--filter", "--dir", "-F"];

/**
 * VER-2: quote-aware split of a shell command line into tokens. Preserves
 * each token's raw text (quotes included) so `parts.join(" ")` reconstructs
 * an equivalent command; a plain `split(/\s+/)` breaks any argument
 * containing whitespace inside quotes (e.g. `"test dir/"`) into multiple
 * bogus parts.
 */
function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const char of command.trim()) {
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

/** Strips one layer of matching surrounding quotes, for content inspection only. */
function unquote(token: string): string {
  if (token.length >= 2 && (token[0] === '"' || token[0] === "'") && token[token.length - 1] === token[0]) {
    return token.slice(1, -1);
  }
  return token;
}

// BUG-26 (D-18): interpreters whose first argument is a script path. The
// smart-runner heuristic must NOT replace that script operand with scoped
// test files — `node 'test/unit/foo.test.ts'` runs the wrong file. Falling
// back to *append* runs a superset (the full suite plus the extra argument),
// which is the fail-safe direction for a verification gate.
const INTERPRETERS = ["node", "bun", "deno", "python", "python3", "ruby", "npx", "tsx", "ts-node"];

export function buildSmartTestCommand(testFiles: string[], baseCommand: string): string {
  if (testFiles.length === 0) {
    return baseCommand;
  }

  const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  const quotedTestFiles = testFiles.map(shellQuote);

  const parts = tokenizeCommand(baseCommand);

  // Find the last token that looks like a path (contains '/') and is a
  // genuinely positional argument — not the value of a path-taking flag.
  let lastPathIndex = -1;
  for (let i = parts.length - 1; i >= 0; i--) {
    const bare = unquote(parts[i]);
    if (!bare.includes("/")) continue;
    const precededByPathFlag = i > 0 && PATH_TAKING_FLAGS.includes(unquote(parts[i - 1]));
    const isCombinedFlagValue = PATH_TAKING_FLAGS.some((flag) => bare.startsWith(`${flag}=`));
    if (precededByPathFlag || isCombinedFlagValue) continue;
    lastPathIndex = i;
    break;
  }

  // BUG-26 (D-18): if the last path candidate is an interpreter's script
  // operand (e.g. `node ./scripts/run-tests.js`), replace-then-append would
  // drop the script and run the wrong target. Fall back to append so the
  // runner executes the script (which then chooses its own scope) with the
  // extra argument as a hint — never the wrong file.
  if (lastPathIndex === 1 && INTERPRETERS.includes(unquote(parts[0]))) {
    return `${baseCommand} ${quotedTestFiles.join(" ")}`;
  }

  if (lastPathIndex === -1) {
    // No path argument — append test files
    return `${baseCommand} ${quotedTestFiles.join(" ")}`;
  }

  // Replace the last path argument with the specific test files,
  // preserving any flags that appear after the path (e.g. --timeout=60000).
  const beforePath = parts.slice(0, lastPathIndex);
  const afterPath = parts.slice(lastPathIndex + 1);
  const newParts = [...beforePath, ...quotedTestFiles, ...afterPath];
  return newParts.join(" ");
}

/**
 * Get changed non-test files since the previous commit.
 *
 * Runs `git diff --name-only <ref>` in the given workdir and returns changed
 * files scoped to the relevant package. Test-file filtering is config-driven
 * via `testFileRegex`; everything else remains language- and layout-agnostic.
 *
 * When `packagePrefix` is set to the story's workdir (e.g. `"packages/api"`),
 * the filter is scoped to `<packagePrefix>/` so nested packages stay isolated.
 * When `testFileRegex` is provided, matching files are excluded.
 *
 * Callers should pass `resolvedTestPatterns.regex` from `resolveTestFilePatterns()`
 * so classification is language-agnostic and config-driven (ADR-009).
 *
 * @param workdir       - Working directory to run git command in
 * @param baseRef       - Git ref for diff base (default: HEAD~1)
 * @param packagePrefix - Story workdir relative to repo root (e.g. "packages/api")
 * @param testFileRegex - Optional regexes to exclude test files from the result
 * @returns Array of changed non-test file paths relative to the git root
 */
export async function getChangedNonTestFiles(
  workdir: string,
  baseRef?: string,
  packagePrefix?: string,
  testFileRegex: RegExp[] = [],
  naxIgnoreIndex?: NaxIgnoreIndex,
  repoRoot?: string,
): Promise<string[]> {
  const ref = baseRef ?? "HEAD~1";
  try {
    // BUG-039: route through _gitUtilDeps.gitWithTimeout to prevent orphan processes on hang
    const { stdout, exitCode, stderr } = await _gitUtilDeps.gitWithTimeout(["diff", "--name-only", ref], workdir);
    if (exitCode !== 0) {
      getSafeLogger()?.warn("verification", "git diff failed — returning empty list", { ref, exitCode, stderr });
      return [];
    }
    const lines = stdout.trim().split("\n").filter(Boolean);
    const effectiveRepoRoot = repoRoot ?? workdir;
    const packageDir = packagePrefix ? join(effectiveRepoRoot, packagePrefix) : undefined;
    const ignoreMatchers =
      naxIgnoreIndex?.getMatchers(packageDir) ?? (await resolveNaxIgnorePatterns(effectiveRepoRoot, packageDir));

    // Issue #565: git diff paths are relative to the true git root, which may be an
    // ancestor of repoRoot. Compute the extra prefix so startsWith filtering works
    // regardless of where the git root sits relative to the project root.
    let effectivePrefix = packagePrefix;
    if (packagePrefix && repoRoot) {
      const gitRoot = await getGitRootMemo(workdir);
      const extraPrefix = gitRoot && gitRoot !== repoRoot ? relative(gitRoot, repoRoot) : "";
      effectivePrefix = extraPrefix ? `${extraPrefix}/${packagePrefix}` : packagePrefix;
    }

    const scopedRaw = effectivePrefix ? lines.filter((f) => f.startsWith(`${effectivePrefix}/`)) : lines;
    // Strip the extraPrefix so returned paths are relative to repoRoot (packagePrefix-relative).
    const extraPrefix =
      effectivePrefix && packagePrefix && effectivePrefix !== packagePrefix
        ? effectivePrefix.slice(0, effectivePrefix.length - packagePrefix.length - 1)
        : "";
    const stripped = extraPrefix ? scopedRaw.map((f) => f.slice(`${extraPrefix}/`.length)) : scopedRaw;
    const scoped = filterNaxInternalPaths(stripped, ignoreMatchers);
    if (testFileRegex.length === 0) return scoped;
    return scoped.filter((f) => !testFileRegex.some((re) => re.test(f)));
  } catch (error) {
    return warnDiffFailed(ref, error);
  }
}

/**
 * Get test files changed since the given git ref, scoped to the package.
 *
 * Unlike `getChangedNonTestFiles`, this function scans the ENTIRE package directory
 * (not just `src/`) so it catches both co-located test files (e.g. `src/foo.test.ts`)
 * and separated test files (e.g. `test/unit/foo.test.ts`). Changed test files are
 * returned as absolute paths ready for direct execution — no source→test mapping
 * needed since they are already tests.
 *
 * Classification uses `testFileRegex` from `resolveTestFilePatterns()` so the
 * detection is language-agnostic and config-driven (ADR-009).
 *
 * @param workdir       - Working directory to run git command in (package dir or repo root)
 * @param repoRoot      - Absolute path to the repository root (for constructing absolute paths)
 * @param baseRef       - Git ref for diff base (default: HEAD~1)
 * @param packagePrefix - Story workdir relative to repo root (e.g. "packages/lib")
 * @param testFileRegex - Regexes identifying test files (from resolveTestFilePatterns().regex)
 * @returns Absolute paths of changed test files
 */
export async function getChangedTestFiles(
  workdir: string,
  repoRoot: string,
  baseRef?: string,
  packagePrefix?: string,
  testFileRegex: RegExp[] = [],
  naxIgnoreIndex?: NaxIgnoreIndex,
): Promise<string[]> {
  if (testFileRegex.length === 0) return [];
  const ref = baseRef ?? "HEAD~1";
  try {
    const { stdout, exitCode, stderr } = await _gitUtilDeps.gitWithTimeout(["diff", "--name-only", ref], workdir);
    if (exitCode !== 0) {
      getSafeLogger()?.warn("verification", "git diff failed — returning empty list", { ref, exitCode, stderr });
      return [];
    }

    const lines = stdout.trim().split("\n").filter(Boolean);
    const packageDir = packagePrefix ? join(repoRoot, packagePrefix) : undefined;
    const ignoreMatchers =
      naxIgnoreIndex?.getMatchers(packageDir) ?? (await resolveNaxIgnorePatterns(repoRoot, packageDir));

    // Issue #565: git diff paths are relative to the true git root, which may be an
    // ancestor of repoRoot. Compute the extra prefix so startsWith filtering works
    // regardless of where the git root sits relative to the project root.
    const gitRoot = await getGitRootMemo(workdir);
    const extraPrefix = gitRoot && gitRoot !== repoRoot ? relative(gitRoot, repoRoot) : "";
    const effectivePrefix = packagePrefix
      ? extraPrefix
        ? `${extraPrefix}/${packagePrefix}`
        : packagePrefix
      : undefined;

    const scopedRaw = effectivePrefix ? lines.filter((f) => f.startsWith(`${effectivePrefix}/`)) : lines;
    const scoped = filterNaxInternalPaths(scopedRaw, ignoreMatchers);
    // Strip the extraPrefix before constructing absolute paths so join(repoRoot, f) is correct.
    const stripped = extraPrefix ? scoped.map((f) => f.slice(`${extraPrefix}/`.length)) : scoped;
    return stripped.filter((f) => testFileRegex.some((re) => re.test(f))).map((f) => join(repoRoot, f));
  } catch (error) {
    return warnDiffFailed(ref, error);
  }
}

/** Shared catch-handler — log a verification-stage warn and return []. @internal */
function warnDiffFailed(ref: string, error: unknown): string[] {
  getSafeLogger()?.warn("verification", "git diff threw — returning empty list", { ref, error: errorMessage(error) });
  return [];
}

/** Test seams (avoid mock.module, which leaks across files in Bun 1.x). @internal */
export const _smartRunnerDeps = {
  /** Wraps Bun.Glob construction — injectable for testing. */
  glob: _bunDeps.glob,
  /** Wraps Bun.file — injectable for testing. */
  file: _bunDeps.file,
  getChangedNonTestFiles,
  getChangedTestFiles,
  mapSourceToTests,
  importGrepFallback,
  buildSmartTestCommand,
};
