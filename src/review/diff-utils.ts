/**
 * Shared diff utilities for review runners (semantic + adversarial).
 *
 * Extracted from semantic.ts to avoid duplication.
 * BUG-114 ref fallback chain lives here as resolveEffectiveRef().
 */

import { spawn } from "bun";
import { getSafeLogger } from "../logger";
import { isTestFile } from "../test-runners";
import { getMergeBase, isGitRefValid } from "../utils/git";
import { filterNaxInternalPaths, resolveNaxIgnorePatterns } from "../utils/path-filters";

/** Maximum diff size in bytes before truncation. 50KB keeps prompts within LLM context. */
export const DIFF_CAP_BYTES = 51_200;

/** nax metadata paths — always excluded from diffs (never production code). */
export const ALWAYS_EXCLUDED = [":!.nax/", ":!.nax-pids"];

async function resolveNaxIgnorePathspecExcludes(workdir: string): Promise<string[]> {
  const matchers = await resolveNaxIgnorePatterns(workdir);
  const pathspec = new Set<string>();
  for (const matcher of matchers) {
    pathspec.add(`:!${matcher.pattern}`);
  }
  return [...pathspec];
}

/** Injectable dependencies for diff-utils — avoids mock.module() in tests. */
export const _diffUtilsDeps = {
  spawn: spawn as typeof spawn,
  isGitRefValid,
  getMergeBase,
};

export interface TestInventory {
  addedTestFiles: string[];
  newSourceFilesWithoutTests: string[];
}

/**
 * Collect git diff for the story range.
 * excludePatterns: pathspec exclusions (e.g. test files for semantic). Pass [] for adversarial (sees all).
 * Always excludes .nax/ and .nax-pids regardless of caller config.
 */
export async function collectDiff(workdir: string, storyGitRef: string, excludePatterns: string[]): Promise<string> {
  const naxIgnoreExcludes = await resolveNaxIgnorePathspecExcludes(workdir);
  const merged = [...new Set([...excludePatterns, ...naxIgnoreExcludes, ...ALWAYS_EXCLUDED])];
  const cmd = ["git", "diff", "--unified=3", `${storyGitRef}..HEAD`, "--", ".", ...merged];
  const proc = _diffUtilsDeps.spawn({
    cmd,
    cwd: workdir,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, stdout] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  return exitCode === 0 ? stdout : "";
}

/**
 * Collect git diff --stat summary (all files including tests — for context).
 * Used as a preamble when the full diff is truncated so the reviewer
 * always knows which files changed even if content is cut off.
 */
export async function collectDiffStat(workdir: string, storyGitRef: string): Promise<string> {
  const naxIgnoreExcludes = await resolveNaxIgnorePathspecExcludes(workdir);
  const merged = [...new Set([...naxIgnoreExcludes, ...ALWAYS_EXCLUDED])];
  const proc = _diffUtilsDeps.spawn({
    cmd: ["git", "diff", "--stat", `${storyGitRef}..HEAD`, "--", ".", ...merged],
    cwd: workdir,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, stdout] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  return exitCode === 0 ? stdout.trim() : "";
}

/**
 * Truncate diff to stay within token budget.
 * When truncated, prepends a --stat summary so the reviewer knows all changed files.
 */
export function truncateDiff(diff: string, stat?: string): string {
  if (diff.length <= DIFF_CAP_BYTES) {
    return diff;
  }

  const truncated = diff.slice(0, DIFF_CAP_BYTES);
  const visibleFiles = (truncated.match(/^diff --git/gm) ?? []).length;
  const totalFiles = (diff.match(/^diff --git/gm) ?? []).length;

  const statPreamble = stat
    ? `## File Summary (all changed files)\n${stat}\n\n## Diff (truncated — ${visibleFiles}/${totalFiles} files shown)\n`
    : "";

  return `${statPreamble}${truncated}\n... (truncated at ${DIFF_CAP_BYTES} bytes, showing ${visibleFiles}/${totalFiles} files)`;
}

/**
 * BUG-114: Resolve the effective git ref for a story's diff range.
 *
 * Priority 1: use supplied ref if valid (persisted from story start).
 * Priority 2: fall back to merge-base with default remote branch so
 *   reviewers always see the full story diff even after a restart.
 * Priority 3: return undefined — caller should skip review.
 */
export async function resolveEffectiveRef(
  workdir: string,
  storyGitRef: string | undefined,
  storyId: string,
): Promise<string | undefined> {
  const logger = getSafeLogger();

  if (storyGitRef && (await _diffUtilsDeps.isGitRefValid(workdir, storyGitRef))) {
    return storyGitRef;
  }

  const fallback = await _diffUtilsDeps.getMergeBase(workdir);
  if (fallback) {
    logger?.info("review", "storyGitRef missing or invalid — using merge-base fallback", {
      storyId,
      storyGitRef,
      fallback,
    });
    return fallback;
  }

  return undefined;
}

/** Default suffix-strip regexes when no testFilePatterns are configured. */
const DEFAULT_SUFFIX_STRIPPERS = [/\.(test|spec)\.(ts|js|tsx|jsx)$/, /_test\.go$/];

/**
 * Build regexes that strip test suffixes from basenames.
 * Derived from the glob patterns (suffix after last `*`), falling back to defaults.
 */
function buildSuffixStrippers(testFilePatterns?: readonly string[]): RegExp[] {
  if (!testFilePatterns || testFilePatterns.length === 0) return DEFAULT_SUFFIX_STRIPPERS;
  const regexes: RegExp[] = [];
  for (const pattern of testFilePatterns) {
    const lastStar = pattern.lastIndexOf("*");
    if (lastStar === -1) continue;
    const suffix = pattern.slice(lastStar + 1);
    if (suffix.length > 0) {
      regexes.push(new RegExp(`${suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
    }
  }
  return regexes.length > 0 ? regexes : DEFAULT_SUFFIX_STRIPPERS;
}

/** Strip the first matching test suffix from a basename, returning the source basename. */
function stripTestSuffix(base: string, strippers: RegExp[]): string {
  for (const re of strippers) {
    const stripped = base.replace(re, "");
    if (stripped !== base) return stripped;
  }
  return base;
}

/**
 * Classify added files in the story's diff into test files vs source files without tests.
 * Used by adversarial review (embedded mode) to pre-compute a TestInventory for the prompt.
 *
 * Detection heuristics:
 * - Test file: path matches configured testFilePatterns (ADR-009), falling back to defaults.
 * - Source file without test: new source file whose basename has no matching test file in the added set.
 *
 * @param testFilePatterns - Configured test file globs (ADR-009). Falls back to DEFAULT_TEST_FILE_PATTERNS.
 */
export async function computeTestInventory(
  workdir: string,
  storyGitRef: string,
  testFilePatterns?: readonly string[],
): Promise<TestInventory> {
  const proc = _diffUtilsDeps.spawn({
    cmd: ["git", "diff", "--name-only", "--diff-filter=A", `${storyGitRef}..HEAD`],
    cwd: workdir,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, stdout] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  if (exitCode !== 0) {
    return { addedTestFiles: [], newSourceFilesWithoutTests: [] };
  }

  const addedFiles = stdout.trim().split("\n").filter(Boolean);
  const ignoreMatchers = await resolveNaxIgnorePatterns(workdir);
  const visibleAddedFiles = filterNaxInternalPaths(addedFiles, ignoreMatchers);

  const addedTestFiles = visibleAddedFiles.filter((f) => isTestFile(f, testFilePatterns));
  const addedSourceFiles = visibleAddedFiles.filter((f) => !isTestFile(f, testFilePatterns));

  // For each added source file, check whether a matching test file was also added.
  // Match by basename: src/foo/bar.ts → looks for bar.test.ts, bar.spec.ts in addedFiles.
  // Suffixes are derived from testFilePatterns so custom patterns (e.g. *.integration.ts) normalize correctly.
  const suffixStrippers = buildSuffixStrippers(testFilePatterns);
  const testFileBasenames = new Set(
    addedTestFiles.map((f) => {
      const base = f.split("/").at(-1) ?? f;
      return stripTestSuffix(base, suffixStrippers);
    }),
  );

  const newSourceFilesWithoutTests = addedSourceFiles.filter((f) => {
    const base = (f.split("/").at(-1) ?? f).replace(/\.(ts|js|tsx|jsx|go)$/, "");
    return !testFileBasenames.has(base);
  });

  return { addedTestFiles, newSourceFilesWithoutTests };
}
