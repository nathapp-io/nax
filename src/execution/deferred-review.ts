/**
 * Deferred Plugin Review (DR-003)
 *
 * Stub — implementation pending. Tests drive the interface.
 */

import { spawn } from "bun";
import type { PluginRegistry } from "../plugins";
import type { ReviewConfig } from "../review/types";

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
export async function captureRunStartRef(_workdir: string): Promise<string> {
  throw new Error("not implemented");
}

/** Run all plugin reviewers once with the full diff since runStartRef. */
export async function runDeferredReview(
  _workdir: string,
  _reviewConfig: ReviewConfig,
  _plugins: PluginRegistry,
  _runStartRef: string,
): Promise<DeferredReviewResult | undefined> {
  throw new Error("not implemented");
}
