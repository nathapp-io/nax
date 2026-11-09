/**
 * Deferred Plugin Review (DR-003)
 *
 * Captures the run-start git ref and runs all plugin reviewers once after
 * all stories complete, using the full diff from run-start to HEAD.
 */

import { errorMessage, gitSpawnEnv, hardenedGitArgv } from "@nathapp/nax-agent/internal";
import { spawn } from "bun";
import type { PluginRegistry } from "../plugins";
import type { ReviewConfig } from "../review/types";
import { GIT_TIMEOUT_MS } from "../utils/git";
import { filterNaxInternalPaths, type NaxIgnoreIndex, resolveNaxIgnorePatterns } from "../utils/path-filters";

/** Injectable deps for testing */
export const _deferredReviewDeps = { spawn };

export interface DeferredReviewResult {
  runStartRef: string;
  changedFiles: string[];
  reviewerResults: Array<{
    name: string;
    passed: boolean;
    output: string;
    exitCode?: number;
    error?: string;
  }>;
  anyFailed: boolean;
}

/**
 * MED-04 — spawn a git command bounded by GIT_TIMEOUT_MS, SIGKILL-ing on
 * timeout. captureRunStartRef is awaited at the very start of executeUnified,
 * before crash handlers register the PID — a wedged git (NFS hang,
 * credential prompt) previously stalled the entire run with no way out.
 * Keeps `_deferredReviewDeps.spawn` as the injection point (rather than
 * delegating to utils/git's gitWithTimeout, which uses a separate `_gitDeps`)
 * so existing tests mocking `_deferredReviewDeps.spawn` are unaffected.
 */
async function spawnGitWithDeadline(
  args: string[],
  workdir: string,
): Promise<{ stdout: string; exitCode: number; timedOut: boolean }> {
  const proc = _deferredReviewDeps.spawn({
    cmd: hardenedGitArgv(["git", ...args]),
    cwd: workdir,
    env: gitSpawnEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  const timerId = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill("SIGKILL");
    } catch {
      // Process may have already exited
    }
  }, GIT_TIMEOUT_MS);

  const stdoutPromise = new Response(proc.stdout).text().catch(() => "");
  const stderrPromise = new Response(proc.stderr).text().catch(() => "");
  try {
    const exitCode = await proc.exited;
    clearTimeout(timerId);
    const [stdout] = await Promise.all([stdoutPromise, stderrPromise]);
    return { stdout, exitCode, timedOut };
  } finally {
    clearTimeout(timerId);
  }
}

/** Capture the current HEAD git ref. Returns "" on failure. */
export async function captureRunStartRef(workdir: string): Promise<string> {
  try {
    const result = await spawnGitWithDeadline(["rev-parse", "HEAD"], workdir);
    return result.exitCode === 0 && !result.timedOut ? result.stdout.trim() : "";
  } catch {
    return "";
  }
}

async function getChangedFilesForDeferred(
  workdir: string,
  baseRef: string,
): Promise<{ ok: true; files: string[] } | { ok: false; error: string }> {
  try {
    const result = await spawnGitWithDeadline(["diff", "--name-only", `${baseRef}...HEAD`], workdir);
    if (result.timedOut) return { ok: false, error: "[deferred-review] git diff timed out" };
    if (result.exitCode !== 0) {
      return { ok: false, error: `[deferred-review] git diff exited with code ${result.exitCode}` };
    }
    return { ok: true, files: result.stdout.trim().split("\n").filter(Boolean) };
  } catch (error) {
    return { ok: false, error: `[deferred-review] git diff failed: ${errorMessage(error)}` };
  }
}

/** Run all plugin reviewers once with the full diff since runStartRef. */
export async function runDeferredReview(
  workdir: string,
  _reviewConfig: ReviewConfig,
  plugins: PluginRegistry,
  runStartRef: string,
  naxIgnoreIndex?: NaxIgnoreIndex,
): Promise<DeferredReviewResult | undefined> {
  const reviewers = plugins.getReviewers();
  if (reviewers.length === 0) {
    return undefined;
  }

  const changedFilesResult = await getChangedFilesForDeferred(workdir, runStartRef);
  if (!changedFilesResult.ok) {
    return {
      runStartRef,
      changedFiles: [],
      reviewerResults: reviewers.map((reviewer) => ({
        name: reviewer.name,
        passed: false,
        output: "",
        error: changedFilesResult.error,
      })),
      anyFailed: true,
    };
  }

  const ignoreMatchers = naxIgnoreIndex?.getMatchers() ?? (await resolveNaxIgnorePatterns(workdir));
  const changedFiles = filterNaxInternalPaths(changedFilesResult.files, ignoreMatchers);

  const reviewerResults: DeferredReviewResult["reviewerResults"] = [];
  let anyFailed = false;

  for (const reviewer of reviewers) {
    try {
      const result = await reviewer.check(workdir, changedFiles);
      reviewerResults.push({
        name: reviewer.name,
        passed: result.passed,
        output: result.output,
        exitCode: result.exitCode,
      });
      if (!result.passed) {
        anyFailed = true;
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      reviewerResults.push({
        name: reviewer.name,
        passed: false,
        output: "",
        error: errorMsg,
      });
      anyFailed = true;
    }
  }

  return { runStartRef, changedFiles, reviewerResults, anyFailed };
}
