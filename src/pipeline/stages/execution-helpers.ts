/**
 * Execution Stage — pure helper functions.
 * Extracted to keep execution.ts under the 400-line limit.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { NaxError } from "../../errors";
import type { FailureCategory } from "../../tdd";
import type { PipelineContext, StageResult } from "../types";

/**
 * Resolve the effective working directory for a story.
 * When story.workdir is set, returns join(repoRoot, story.workdir).
 * Otherwise returns the repo root unchanged.
 *
 * MW-001 runtime check: throws if the resolved workdir does not exist on disk.
 */
export function resolveStoryWorkdir(repoRoot: string, storyWorkdir?: string): string {
  if (!storyWorkdir) return repoRoot;
  const resolved = join(repoRoot, storyWorkdir);
  if (!existsSync(resolved)) {
    throw new NaxError(
      `[execution] story.workdir "${storyWorkdir}" does not exist at "${resolved}"`,
      "WORKDIR_NOT_FOUND",
      { stage: "execution", storyWorkdir, resolved },
    );
  }
  return resolved;
}

/**
 * Detect if agent output contains ambiguity signals.
 * Checks for keywords that indicate the agent is unsure about the implementation.
 */
export function isAmbiguousOutput(output: string): boolean {
  if (!output) return false;
  const ambiguityKeywords = [
    "unclear",
    "ambiguous",
    "need clarification",
    "please clarify",
    "which one",
    "not sure which",
  ];
  const lowerOutput = output.toLowerCase();
  return ambiguityKeywords.some((keyword) => lowerOutput.includes(keyword));
}

/**
 * Determine the pipeline action for a failed TDD result, based on its failureCategory.
 *
 * Pure routing function — mutates only ctx.retryAsLite when needed.
 * Exported for unit testing.
 */
export function routeTddFailure(
  failureCategory: FailureCategory | undefined,
  isLiteMode: boolean,
  ctx: Pick<PipelineContext, "retryAsLite">,
  reviewReason?: string,
): StageResult {
  if (failureCategory === "isolation-violation") {
    if (!isLiteMode) {
      ctx.retryAsLite = true;
    }
    return { action: "escalate" };
  }

  if (
    failureCategory === "session-failure" ||
    failureCategory === "tests-failing" ||
    failureCategory === "verifier-rejected"
  ) {
    return { action: "escalate" };
  }

  // S5: greenfield-no-tests → escalate so tier-escalation can switch to test-after
  if (failureCategory === "greenfield-no-tests") {
    return { action: "escalate" };
  }

  return {
    action: "pause",
    reason: reviewReason || "Three-session TDD requires review",
  };
}
