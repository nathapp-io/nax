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
 * Stub state (RED): both exported functions throw "not implemented", and their
 * parameters carry the project's `_` prefix for that reason alone. The
 * implementation uses the spec's names — `reviewConfig`, `phases`, `ctx`,
 * `pair`, `tracking`, `isThreeSession`, `progress`.
 */
import type { CallContext } from "@/operations";
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
  _reviewConfig: { adversarial?: { parallel?: boolean; maxConcurrentSessions?: number } } | undefined,
  _phases: readonly InternalPhase[],
): boolean {
  throw new Error("not implemented"); // nax-lint-allow: plain-error
}

/**
 * Run both reviews of `pair` ([semantic-review, adversarial-review])
 * concurrently, waiting for both to settle before returning — or rethrowing the
 * `semantic-review` error, which wins when both reviews throw. Results land in
 * `tracking.phaseOutputs` / `tracking.phaseCosts` via `runPhase`.
 */
export async function runReviewPair(
  _ctx: CallContext,
  _pair: readonly [InternalPhase, InternalPhase],
  _tracking: PhaseTracking,
  _isThreeSession?: boolean,
  _progress?: { indices: readonly [number, number]; total: number },
): Promise<void> {
  throw new Error("not implemented"); // nax-lint-allow: plain-error
}
