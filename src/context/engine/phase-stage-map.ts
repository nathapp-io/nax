/**
 * Op-name -> context-engine stage-key mapping (nax#1737 Phase B).
 *
 * `STAGE_CONTEXT_MAP` (stage-config.ts) declares role/budget/providers/
 * pullToolNames for stage keys that nothing assembled a bundle for before
 * this change — see docs/architecture and the Phase B spec for the full
 * background. `runPhase` (src/execution/story-orchestrator/run-phase.ts) is
 * the single dispatch seam for both the CANONICAL_ORDER phases and the
 * rectification fix cycle, so this mapping is keyed off `op.name` (an
 * operation identity), never `op.stage` (a *permissions* PipelineStage —
 * "run" / "review" / "verify" / "rectification" — a different namespace).
 */

/** Op names that only map to a TDD context-engine stage under three-session strategies. */
const THREE_SESSION_STAGE_MAP: Readonly<Record<string, string>> = {
  "test-writer": "tdd-test-writer",
  implementer: "tdd-implementer",
  verifier: "tdd-verifier",
};

/** Op names that map to a context-engine stage regardless of session model. */
const UNCONDITIONAL_STAGE_MAP: Readonly<Record<string, string>> = {
  "semantic-review": "review-semantic",
  "adversarial-review": "review-adversarial",
  rectify: "rectify",
};

/**
 * Resolve the context-engine stage key for a dispatched op, or `undefined`
 * when the op keeps whatever bundle `ctx.contextBundle` already carries
 * (Phase A's non-regression guarantee).
 */
export function contextStageForOp(opName: string, isThreeSession: boolean): string | undefined {
  if (isThreeSession) {
    const threeSessionStage = THREE_SESSION_STAGE_MAP[opName];
    if (threeSessionStage) return threeSessionStage;
  }
  return UNCONDITIONAL_STAGE_MAP[opName];
}
