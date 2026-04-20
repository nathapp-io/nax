/**
 * Deferred Plugin Review (DR-003)
 *
 * Captures the run-start git ref and runs all plugin reviewers once after
 * all stories complete, using the full diff from run-start to HEAD.
 */

import { spawn } from "bun";
import type { PluginRegistry } from "../plugins";
import type { ReviewConfig } from "../review/types";
import { filterNaxInternalPaths, resolveNaxIgnorePatterns } from "../utils/path-filters";

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

/** Capture the current HEAD git ref. Returns "" on failure. */
export async function captureRunStartRef(workdir: string): Promise<string> {
  try {
    const proc = _deferredReviewDeps.spawn({
      cmd: ["git", "rev-parse", "HEAD"],
      cwd: workdir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    return stdout.trim();
  } catch {
    return "";
  }
}

async function getChangedFilesForDeferred(workdir: string, baseRef: string): Promise<string[]> {
  try {
    const proc = _deferredReviewDeps.spawn({
      cmd: ["git", "diff", "--name-only", `${baseRef}...HEAD`],
      cwd: workdir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    return stdout.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/** Run all plugin reviewers once with the full diff since runStartRef. */
export async function runDeferredReview(
  workdir: string,
  reviewConfig: ReviewConfig,
  plugins: PluginRegistry,
  runStartRef: string,
): Promise<DeferredReviewResult | undefined> {
  if (!reviewConfig || reviewConfig.pluginMode !== "deferred") {
    return undefined;
  }

  const reviewers = plugins.getReviewers();
  if (reviewers.length === 0) {
    return undefined;
  }

  const changedFilesRaw = await getChangedFilesForDeferred(workdir, runStartRef);
  const ignoreMatchers = await resolveNaxIgnorePatterns(workdir);
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
