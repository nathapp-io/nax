/**
 * Deferred Plugin Review (DR-003)
 *
 * Captures the run-start git ref and runs all plugin reviewers once after
 * all stories complete, using the full diff from run-start to HEAD.
 */

import { spawn } from "bun";
import type { PluginRegistry } from "../plugins";
import type { ReviewConfig } from "../review/types";
import { GIT_TIMEOUT_MS } from "../utils/git";
import { type NaxIgnoreIndex, filterNaxInternalPaths, resolveNaxIgnorePatterns } from "../utils/path-filters";

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
async function spawnGitWithDeadline(cmd: string[], workdir: string): Promise<string> {
  const proc = _deferredReviewDeps.spawn({ cmd, cwd: workdir, stdout: "pipe", stderr: "pipe" });

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
  await proc.exited;
  clearTimeout(timerId);

  if (timedOut) return "";
  return stdoutPromise;
}

/** Capture the current HEAD git ref. Returns "" on failure. */
export async function captureRunStartRef(workdir: string): Promise<string> {
  try {
    const stdout = await spawnGitWithDeadline(["git", "rev-parse", "HEAD"], workdir);
    return stdout.trim();
  } catch {
    return "";
  }
}

async function getChangedFilesForDeferred(workdir: string, baseRef: string): Promise<string[]> {
  try {
    const stdout = await spawnGitWithDeadline(["git", "diff", "--name-only", `${baseRef}...HEAD`], workdir);
    return stdout.trim().split("\n").filter(Boolean);
  } catch {
    return [];
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

  const changedFilesRaw = await getChangedFilesForDeferred(workdir, runStartRef);
  const ignoreMatchers = naxIgnoreIndex?.getMatchers() ?? (await resolveNaxIgnorePatterns(workdir));
  const changedFiles = filterNaxInternalPaths(changedFilesRaw, ignoreMatchers);

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
