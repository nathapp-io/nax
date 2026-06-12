/**
 * Execution Stage — pure helper functions.
 * Extracted to keep execution.ts under the 400-line limit.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { NaxError } from "../../errors";
import type { FailureCategory } from "../../tdd";
import type { PipelineContext, StageResult } from "../types";
import type { AgentAdapter } from "../../agents/types";

export interface ResolvedExecutionAgent {
  agentName: string;
  agent: AgentAdapter | undefined;
  /** True when the routed agent could not be resolved and we fell back to the default. */
  degraded: boolean;
}

/**
 * Availability seam: a planned-but-unavailable agent degrades to the default
 * agent instead of failing the story. Caller logs when `degraded` is true.
 */
export function resolveExecutionAgent(opts: {
  routedAgent: string | undefined;
  defaultAgent: string;
  getAgent: (name: string) => AgentAdapter | undefined;
}): ResolvedExecutionAgent {
  const { routedAgent, defaultAgent, getAgent } = opts;
  if (routedAgent !== undefined) {
    const routed = getAgent(routedAgent);
    if (routed) return { agentName: routedAgent, agent: routed, degraded: false };
    return { agentName: defaultAgent, agent: getAgent(defaultAgent), degraded: true };
  }
  return { agentName: defaultAgent, agent: getAgent(defaultAgent), degraded: false };
}

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
  failureDetail?: string,
): StageResult {
  // Build a meaningful reason for escalation so priorErrors/priorFailures carry
  // the failure category (and any extra detail) into the next tier's prompt
  // instead of a generic "Failed with tier X, escalating".
  const buildReason = (category: FailureCategory): string => {
    const trimmedDetail = failureDetail?.trim();
    return trimmedDetail ? `TDD ${category}: ${trimmedDetail}` : `TDD ${category}`;
  };

  if (failureCategory === "isolation-violation") {
    if (!isLiteMode) {
      ctx.retryAsLite = true;
    }
    return { action: "escalate", reason: buildReason("isolation-violation") };
  }

  if (
    failureCategory === "session-failure" ||
    failureCategory === "tests-failing" ||
    failureCategory === "full-suite-gate-exhausted" ||
    failureCategory === "verifier-rejected" ||
    failureCategory === "runtime-crash"
  ) {
    return { action: "escalate", reason: buildReason(failureCategory) };
  }

  // S5: greenfield-no-tests → escalate so tier-escalation can switch to test-after
  if (failureCategory === "greenfield-no-tests") {
    return { action: "escalate", reason: buildReason("greenfield-no-tests") };
  }

  return {
    action: "pause",
    reason: reviewReason || "Three-session TDD requires review",
  };
}
