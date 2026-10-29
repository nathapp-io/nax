/**
 * The loop limit for a run (nax#2706).
 *
 * Pipeline mode keeps `execution.maxIterations`. Workflow mode derives it from the work left and
 * ignores that setting. A workflow iteration runs one story: fix rounds and tier escalation happen
 * inside the story loop and the workflow stage never returns `escalate`. An iteration does not always
 * settle its story, though. A non-workflow stage that throws or returns `fail` (routing, constitution,
 * queue-check, a PRD save) marks the story failed, and the selector then retries it; and a pending
 * story with attempts already spent can cost one iteration on the pre-iteration tier-budget escalation
 * before it runs. So the limit is measured from where the run is now: the iterations already done,
 * plus the pending stories, plus the failed story the selector would retry next, plus one for that
 * escalation hop for each pending story with spent attempts, plus one for the completion pass.
 * Recomputed every iteration, it also follows work added mid-run. Failures bump `attempts` toward
 * `rectification.maxAttemptsTotal`, so retries are finite; an iteration that changes nothing in the
 * PRD is caught by `progressSignature`.
 */

import { isWorkflowMode, type NaxConfig } from "@/config";
import { pendingStories } from "@/prd";
import type { PRD } from "@/prd/types";
import { resolveRetryCandidate } from "./story-selector";

/** Iterations still needed from this point: the work left plus the completion pass. */
export function workflowIterationsRemaining(prd: PRD, config: NaxConfig, lastStoryId: string | null): number {
  const pending = pendingStories(prd);
  const retry = resolveRetryCandidate(prd, lastStoryId, config) ? 1 : 0;
  const escalationHops = config.autoMode.escalation.enabled ? pending.filter((s) => (s.attempts ?? 0) > 0).length : 0;
  return pending.length + retry + escalationHops + 1;
}

/** The loop runs while `iterations < limit`: derived in workflow mode, `execution.maxIterations` otherwise. */
export function loopIterationLimit(
  prd: PRD,
  config: NaxConfig,
  iterationsDone: number,
  lastStoryId: string | null,
): number {
  return isWorkflowMode(config)
    ? iterationsDone + workflowIterationsRemaining(prd, config, lastStoryId)
    : config.execution.maxIterations;
}

/** A fingerprint of the parts of the PRD an iteration moves; equal before and after means no progress. */
export function progressSignature(prd: PRD): string {
  return prd.userStories
    .map((s) => `${s.id}:${s.status}:${s.passes ? 1 : 0}:${s.attempts ?? 0}:${s.escalations?.length ?? 0}`)
    .join("|");
}
