/**
 * Shared diff utilities for review runners.
 *
 * Extracted from semantic.ts to avoid duplication.
 * BUG-114 ref fallback chain lives here as resolveEffectiveRef().
 */

import { gitSpawnEnv, hardenedGitArgv } from "@nathapp/nax-agent/internal";
import { spawn } from "bun";
import { getSafeLogger } from "../logger";
import { GIT_TIMEOUT_MS, getMergeBase, isGitRefValid } from "../utils/git";
import { NAX_OWNED_REVIEW_EXCLUDE_PATHSPECS } from "../utils/nax-owned-paths";
import { type NaxIgnoreIndex, resolveNaxIgnorePatterns } from "../utils/path-filters";

/** Maximum diff size in bytes before truncation. 50KB keeps prompts within LLM context. */
export const DIFF_CAP_BYTES = 51_200;

/** nax metadata paths — always excluded from diffs (never production code). */
export const ALWAYS_EXCLUDED: string[] = [...NAX_OWNED_REVIEW_EXCLUDE_PATHSPECS];

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

/**
 * Injectable dependencies for diff-utils — avoids mock.module() in tests.
 *
 * `timeoutMs` is injectable (same convention as `_isolationDeps` in
 * `src/tdd/isolation.ts` and `_gitDeps.gitTimeoutMs` in `src/utils/git.ts`) so
 * the BUG-31 hang-path tests can assert the SIGKILL contract without burning
 * the full production deadline in wall-clock.
 */
export const _diffUtilsDeps = {
  spawn: spawn as typeof spawn,
  isGitRefValid,
  getMergeBase,
  timeoutMs: GIT_TIMEOUT_MS,
};

// BUG-31: route every git spawn through this helper so a wedged git
// (NFS / lock contention) cannot stall the review stage indefinitely.
// The convention `gitWithTimeout` (`src/utils/git.ts`) exists for the
// exact same reason — diff-utils predates that convention and bypassed
// it; this wrapper applies the same deadline + drain-on-exit semantics
// to the existing tests' mocked `_diffUtilsDeps.spawn`.
async function runGitWithTimeout(
  args: string[],
  workdir: string,
  timeoutMs: number = _diffUtilsDeps.timeoutMs,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = _diffUtilsDeps.spawn({
    cmd: hardenedGitArgv(["git", ...args]),
    cwd: workdir,
    env: gitSpawnEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });

  type RunResult = { kind: "exit"; code: number } | { kind: "timeout" };
  let resolveTimeout: (v: RunResult) => void = () => {};
  const exitPromise = proc.exited.then<RunResult>((code) => ({ kind: "exit", code }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<RunResult>((resolve) => {
    resolveTimeout = resolve;
    // SIGKILL on timeout so a wedged git releases its pipes and proc.exited
    // can settle. Best-effort — kill may fail if the process is already gone.
    timer = setTimeout(() => {
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
  clearTimeout(timer);

  if (result.kind === "timeout") {
    // Don't await the drain promises here — a SIGKILL'd process's pipes
    // may never close in test mocks and are irrelevant anyway.
    return { stdout: "", stderr: "", exitCode: 1 };
  }

  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  return { stdout, stderr, exitCode: result.code };
}

/**
 * Build the shared `git diff` args (argv after `git`, which
 * `runGitWithTimeout` prepends) for the story-range collector below.
 *
 * It deliberately omits `--relative`: the agent's file tools are repo-rooted
 * after the single-frame redesign, so repo-root-relative paths are read
 * directly. The collector's own cwd (`workdir` — still the package dir for a
 * package story) scopes the bare `-- .` pathspec. `excludePathspecs` ride as
 * trailing `:!` pathspec exclusions.
 */
function buildDiffArgv(flags: readonly string[], ref: string, excludePathspecs: readonly string[] = []): string[] {
  return ["diff", ...flags, `${ref}..HEAD`, "--", ".", ...excludePathspecs];
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

/**
 * Collect the list of file paths modified between `storyGitRef` and HEAD.
 *
 * Live caller: `pipeline/scope-files.ts`, which unions the diff with the story's
 * declared sources. Returns `undefined` on git failure so callers can degrade
 * rather than treat "git failed" as "nothing changed".
 *
 * DELIBERATELY WITHOUT `--relative`, the convention the review collectors
 * shared. It feeds the AGENT, whose file tools are repo-rooted after the
 * single-frame redesign, and `scopeFiles`, which is repo-rooted by
 * the path-frame convention (nax#2071), so repo-rooted output is the correct
 * spelling and the caller frames the declared side to match. The `-- .`
 * pathspec already restricts output to the cwd subtree, so `--relative` would
 * change the spelling only, never the file set.
 */
export async function collectDiffFileList(
  workdir: string,
  storyGitRef: string,
  options?: DiffIgnoreOptions,
): Promise<string[] | undefined> {
  const naxIgnoreExcludes = await resolveNaxIgnorePathspecExcludes(workdir, options);
  const merged = [...new Set([...naxIgnoreExcludes, ...ALWAYS_EXCLUDED])];
  // BUG-31: route through runGitWithTimeout.
  const { stdout, exitCode } = await runGitWithTimeout(buildDiffArgv(["--name-only"], storyGitRef, merged), workdir);

  if (exitCode !== 0) return undefined;
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
