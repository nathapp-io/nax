/**
 * Shared diff utilities for review runners (semantic + adversarial).
 *
 * Extracted from semantic.ts to avoid duplication.
 * BUG-114 ref fallback chain lives here as resolveEffectiveRef().
 */

import { spawn } from "bun";
import { getSafeLogger } from "../logger";
import { isTestFile } from "../test-runners";
import { GIT_TIMEOUT_MS, getMergeBase, isGitRefValid } from "../utils/git";
import { type NaxIgnoreIndex, filterNaxInternalPaths, resolveNaxIgnorePatterns } from "../utils/path-filters";

/** Maximum diff size in bytes before truncation. 50KB keeps prompts within LLM context. */
export const DIFF_CAP_BYTES = 51_200;

/** nax metadata paths — always excluded from diffs (never production code). */
export const ALWAYS_EXCLUDED = [":!.nax/", ":!.nax-pids"];

interface DiffIgnoreOptions {
  naxIgnoreIndex?: NaxIgnoreIndex;
  packageDir?: string;
}

async function resolveNaxIgnorePathspecExcludes(workdir: string, options?: DiffIgnoreOptions): Promise<string[]> {
  if (options?.naxIgnoreIndex) return options.naxIgnoreIndex.toPathspecExcludes(options.packageDir);
  const matchers = await resolveNaxIgnorePatterns(workdir, options?.packageDir);
  const pathspec = new Set<string>();
  for (const matcher of matchers) pathspec.add(`:!${matcher.pattern}`);
  return [...pathspec];
}

/** Injectable dependencies for diff-utils — avoids mock.module() in tests. */
export const _diffUtilsDeps = {
  spawn: spawn as typeof spawn,
  isGitRefValid,
  getMergeBase,
};

// BUG-31: route every git spawn through this helper so a wedged git
// (NFS / lock contention) cannot stall the review stage indefinitely.
// The convention `gitWithTimeout` (`src/utils/git.ts`) exists for the
// exact same reason — diff-utils predates that convention and bypassed
// it; this wrapper applies the same deadline + drain-on-exit semantics
// to the existing tests' mocked `_diffUtilsDeps.spawn`.
async function runGitWithTimeout(
  cmd: string[],
  workdir: string,
  timeoutMs: number = GIT_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = _diffUtilsDeps.spawn({
    cmd,
    cwd: workdir,
    stdout: "pipe",
    stderr: "pipe",
  });

  type RunResult = { kind: "exit"; code: number } | { kind: "timeout" };
  let resolveTimeout: (v: RunResult) => void = () => {};
  const exitPromise = proc.exited.then<RunResult>((code) => ({ kind: "exit", code }));
  const timeoutPromise = new Promise<RunResult>((resolve) => {
    resolveTimeout = resolve;
    // SIGKILL on timeout so a wedged git releases its pipes and proc.exited
    // can settle. Best-effort — kill may fail if the process is already gone.
    setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // Process may have already exited
      }
      resolveTimeout({ kind: "timeout" });
    }, timeoutMs);
  });

  // Drain stdout/stderr concurrently — a process that fills either pipe's
  // OS buffer (>64KB) before being read would otherwise block on the write
  // and never reach `exited`, defeating the timeout's own SIGKILL.
  const stdoutPromise = new Response(proc.stdout).text().catch(() => "");
  const stderrPromise = new Response(proc.stderr).text().catch(() => "");

  const result = await Promise.race([exitPromise, timeoutPromise]);

  if (result.kind === "timeout") {
    // Don't await the drain promises here — a SIGKILL'd process's pipes
    // may never close in test mocks and are irrelevant anyway.
    return { stdout: "", stderr: "", exitCode: 1 };
  }

  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  return { stdout, stderr, exitCode: result.code };
}

export interface TestInventory {
  addedTestFiles: string[];
  newSourceFilesWithoutTests: string[];
}

/**
 * Collect git diff for the story range.
 * excludePatterns: pathspec exclusions (e.g. test files for semantic). Pass [] for adversarial (sees all).
 * Always excludes .nax/ and .nax-pids regardless of caller config.
 */
export async function collectDiff(
  workdir: string,
  storyGitRef: string,
  excludePatterns: string[],
  options?: DiffIgnoreOptions,
): Promise<string | null> {
  const naxIgnoreExcludes = await resolveNaxIgnorePathspecExcludes(workdir, options);
  const merged = [...new Set([...excludePatterns, ...naxIgnoreExcludes, ...ALWAYS_EXCLUDED])];
  // BUG-31: route through runGitWithTimeout — a wedged git (NFS / lock
  // contention) must not stall the review stage indefinitely.
  const { stdout, stderr, exitCode } = await runGitWithTimeout(
    ["git", "diff", "--unified=3", `${storyGitRef}..HEAD`, "--", ".", ...merged],
    workdir,
  );

  if (exitCode !== 0) {
    getSafeLogger()?.warn("diff-utils", "git diff failed — skipping review diff", { storyGitRef, stderr });
    return null;
  }
  return stdout;
}

/**
 * Collect git diff --stat summary (all files including tests — for context).
 * Used as a preamble when the full diff is truncated so the reviewer
 * always knows which files changed even if content is cut off.
 */
export async function collectDiffStat(
  workdir: string,
  storyGitRef: string,
  options?: DiffIgnoreOptions,
): Promise<string> {
  const naxIgnoreExcludes = await resolveNaxIgnorePathspecExcludes(workdir, options);
  const merged = [...new Set([...naxIgnoreExcludes, ...ALWAYS_EXCLUDED])];
  // BUG-31: route through runGitWithTimeout — same convention as collectDiff.
  const { stdout, exitCode } = await runGitWithTimeout(
    ["git", "diff", "--stat", `${storyGitRef}..HEAD`, "--", ".", ...merged],
    workdir,
  );

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
  options?: DiffIgnoreOptions,
): Promise<TestInventory> {
  const { stdout, exitCode } = await runGitWithTimeout(
    ["git", "diff", "--name-only", "--diff-filter=A", `${storyGitRef}..HEAD`],
    workdir,
  );

  if (exitCode !== 0) {
    return { addedTestFiles: [], newSourceFilesWithoutTests: [] };
  }

  const addedFiles = stdout.trim().split("\n").filter(Boolean);
  const ignoreMatchers =
    options?.naxIgnoreIndex?.getMatchers(options.packageDir) ??
    (await resolveNaxIgnorePatterns(workdir, options?.packageDir));
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

/**
 * Collect the list of file paths modified between `storyGitRef` and HEAD.
 *
 * Used by adversarial review (#986) in `mode: "ref"` to compute the
 * `fileInDiff` axis of the structural counterfactual telemetry without
 * inspecting an inline diff. Returns `undefined` on git failure so callers
 * can mark `diffAvailable: false`.
 */
export async function collectDiffFileList(
  workdir: string,
  storyGitRef: string,
  options?: DiffIgnoreOptions,
): Promise<string[] | undefined> {
  const naxIgnoreExcludes = await resolveNaxIgnorePathspecExcludes(workdir, options);
  const merged = [...new Set([...naxIgnoreExcludes, ...ALWAYS_EXCLUDED])];
  // BUG-31: route through runGitWithTimeout.
  const { stdout, exitCode } = await runGitWithTimeout(
    ["git", "diff", "--name-only", `${storyGitRef}..HEAD`, "--", ".", ...merged],
    workdir,
  );

  if (exitCode !== 0) return undefined;
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
