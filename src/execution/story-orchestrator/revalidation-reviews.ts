/**
 * US-003 — the revalidation sweep's per-phase dispatch step.
 *
 * The rectification validate sweep used to dispatch each selected phase through
 * `runPhase` one at a time. `rectification.ts` is already at 597 of its 600
 * allowed source lines, so the dispatch step lives here instead: it dispatches
 * `phase` through `runPhase` — or, when `phase` is `semantic-review` and
 * `shouldRunReviewsConcurrently` is true for the whole sweep, dispatches the
 * review pair through `runReviewPair` — and reports the kinds this call
 * dispatched so the caller can skip them when the sweep reaches them again.
 *
 * Review config is resolved as `ctx.config?.review ?? ctx.packageView.config.review`,
 * the same expression `nbf-deps.ts` and the canonical loop use.
 */
import type { CallContext } from "@/operations";
import type { PhaseTracking } from "./execution-plan-phases";
import type { InternalPhase, PhaseKind } from "./types";

/**
 * Dispatch one phase of the revalidation sweep and return the kinds this call
 * dispatched: just `phase.kind` for the ordinary single-phase dispatch, or both
 * review kinds when the pair ran.
 */
export async function dispatchRevalidationPhase(
  ctx: CallContext,
  phase: InternalPhase,
  phases: readonly InternalPhase[],
  tracking: PhaseTracking,
  isThreeSession?: boolean,
): Promise<readonly PhaseKind[]> {
  // STUB — the implementer replaces this body with the real dispatch. The
  // parameters are named and referenced to keep the signature verbatim.
  void ctx;
  void phase;
  void phases;
  void tracking;
  void isThreeSession;
  return [];
}
