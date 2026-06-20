/**
 * Execution Stage — pure helper functions.
 * Extracted to keep execution.ts under the 400-line limit.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentAdapter } from "@/agents/types";
import { NaxError } from "@/errors";
import type { PipelineContext, StageResult } from "@/pipeline/types";
import type { FailureCategory } from "@/tdd";

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

  // No specific category (e.g. a non-TDD-categorizable quality/review failure, or a
  // non-three-session review verdict) → fall back to the human-review pause.
  const pauseFallback: StageResult = {
    action: "pause",
    reason: reviewReason || "Three-session TDD requires review",
  };
  if (failureCategory === undefined) {
    return pauseFallback;
  }

  // Exhaustive over FailureCategory: a new member added to the union must be routed
  // here explicitly, or the `satisfies never` default below fails compilation. Mirrors
  // the guard in `resolveMaxAttemptsOutcome` so both terminal paths stay in lockstep.
  switch (failureCategory) {
    case "isolation-violation":
      if (!isLiteMode) {
        ctx.retryAsLite = true;
      }
      return { action: "escalate", reason: buildReason("isolation-violation") };
    case "session-failure":
    case "tests-failing":
    case "full-suite-gate-exhausted":
    case "verifier-rejected":
    case "runtime-crash":
    case "review-incomplete":
    // S5: greenfield-no-tests → escalate so tier-escalation can switch to test-after
    case "greenfield-no-tests":
      return { action: "escalate", reason: buildReason(failureCategory) };
    case "dependency-prep":
      // Worktree dependency prep hard-fails in the iteration runner before the
      // pipeline routes here, so this arm is unreachable in practice — handled
      // explicitly to keep the exhaustiveness check honest. An infra prep failure
      // is not auto-recoverable by a stronger tier, so pause for human review.
      return pauseFallback;
    default:
      // Exhaustive check: if a new FailureCategory is added, this errors at compile time.
      failureCategory satisfies never;
      return pauseFallback;
  }
}
