/**
 * US-001 — the concurrent review pair for one story.
 *
 * `runReviewPair` dispatches `semantic-review` and `adversarial-review`
 * concurrently by calling the existing `runPhase` for each; `runPhase` is
 * unchanged. The pair waits for both reviews to settle and never cancels one
 * review because its sibling failed. `shouldRunReviewsConcurrently` is the
 * caller's eligibility predicate: the reviews run concurrently only when
 * `review.adversarial.parallel` is `true`, `maxConcurrentSessions` is 2 or more
 * (each review is one session, the debate feature having been removed) and both
 * `semantic-review` and `adversarial-review` are among the phases the CALLER is
 * about to run. Anything else keeps sequential behaviour unchanged, including
 * the #1666 rule that a `semantic-review` failure continues to
 * `adversarial-review` in the canonical loop.
 *
 * Callers resolve the review config as
 * `ctx.config?.review ?? ctx.packageView.config.review` (as `nbf-deps.ts` does)
 * and pass that value to `shouldRunReviewsConcurrently`; `runReviewPair` itself
 * receives only the call context, the pair, the tracking records and the
 * session flag.
 *
 */
import { getSafeLogger } from "@/logger";
import type { CallContext } from "@/operations";
import { errorMessage } from "@/utils/errors";
import type { PhaseTracking } from "./execution-plan-phases";
import { runPhase } from "./run-phase";
import type { InternalPhase } from "./types";

/**
 * Injectable seam for the phase dispatcher the pair runs its two reviews
 * through. Mirrors `_storyOrchestratorDeps` / `_nbfDeps` so a test can observe
 * the pair's wiring without `mock.module()`; production uses the real
 * `runPhase`.
 */
export const _reviewPairDeps: { runPhase: typeof runPhase } = { runPhase };

/**
 * True when the two review phases may run concurrently: `parallel` is on, the
 * cap leaves room for both reviewer sessions, and the caller is about to run
 * both phases. An unset cap resolves to the schema default of 2.
 */
export function shouldRunReviewsConcurrently(
  reviewConfig: { adversarial?: { parallel?: boolean; maxConcurrentSessions?: number } } | undefined,
  phases: readonly InternalPhase[],
): boolean {
  const adversarial = reviewConfig?.adversarial;
  const maxConcurrentSessions = adversarial?.maxConcurrentSessions ?? 2;
  return (
    adversarial?.parallel === true &&
    maxConcurrentSessions >= 2 &&
    phases.some((phase) => phase.kind === "semantic-review") &&
    phases.some((phase) => phase.kind === "adversarial-review")
  );
}

/**
 * Run both reviews of `pair` ([semantic-review, adversarial-review])
 * concurrently, waiting for both to settle before returning — or rethrowing the
 * `semantic-review` error, which wins when both reviews throw. Results land in
 * `tracking.phaseOutputs` / `tracking.phaseCosts` via `runPhase`.
 */
export async function runReviewPair(
  ctx: CallContext,
  pair: readonly [InternalPhase, InternalPhase],
  tracking: PhaseTracking,
  isThreeSession = false,
  progress?: { indices: readonly [number, number]; total: number },
): Promise<void> {
  getSafeLogger()?.info("story-orchestrator", "Running semantic-review and adversarial-review concurrently", {
    storyId: ctx.storyId,
  });

  const outcomes = await Promise.allSettled(
    pair.map((phase, index) =>
      _reviewPairDeps.runPhase(
        ctx,
        phase.slot,
        tracking.phaseCosts,
        tracking.phaseOutputs,
        isThreeSession,
        progress
          ? { index: index === 0 ? progress.indices[0] : progress.indices[1], total: progress.total }
          : undefined,
      ),
    ),
  );
  const logger = getSafeLogger();
  for (const [index, outcome] of outcomes.entries()) {
    if (outcome.status === "rejected") {
      logger?.error("story-orchestrator", "Phase threw unexpected error", {
        storyId: ctx.storyId,
        phase: index === 0 ? pair[0].kind : pair[1].kind,
        error: errorMessage(outcome.reason),
      });
    }
  }
  const semanticOutcome = outcomes[0];
  if (semanticOutcome?.status === "rejected") throw semanticOutcome.reason;
  const adversarialOutcome = outcomes[1];
  if (adversarialOutcome?.status === "rejected") throw adversarialOutcome.reason;
}
