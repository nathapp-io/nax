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

import type { TestStrategy } from "@/config";
import type { StageKey } from "./stage-config";

/** Op names that only map to a TDD context-engine stage under three-session strategies. */
const THREE_SESSION_STAGE_MAP: Readonly<Record<string, StageKey>> = {
  "test-writer": "tdd-test-writer",
  implementer: "tdd-implementer",
  verifier: "tdd-verifier",
};

/** Op names that map to a context-engine stage regardless of session model. */
const UNCONDITIONAL_STAGE_MAP: Readonly<Record<string, StageKey>> = {
  "semantic-review": "review-semantic",
  "adversarial-review": "review-adversarial",
  // rectifyOp (src/operations/rectify.ts) has no production dispatcher today
  // (nax#1737 Phase B follow-up finding) — this entry is currently inert.
  // Retained for correctness if rectifyOp is ever wired to a caller.
  rectify: "rectify",
};

/**
 * Op names that map to the `rectify` context-engine stage when dispatched
 * inside the rectification fix cycle (nax#1737 Phase B2). These are the ops
 * `build-plan-for-strategy.ts` actually assembles into fix-cycle strategies.
 *
 * `implementer` maps to `rectify` here — not `tdd-implementer` — because
 * inside the fix cycle it is doing rectification work and needs `rectify`'s
 * `query_scratch` pull tool (re-reading the current verify-result on retry,
 * US-005 AC11), not the TDD-session bundle. See `contextStageForOp` below for
 * why this branch is checked before the three-session branch.
 *
 * Two ops from the fix-cycle roster are deliberately NOT here — do not "fix"
 * this by adding them:
 *   - `mechanical-lintfix` / `mechanical-formatfix` — `kind: "deterministic"`.
 *     They never dispatch to an agent, so assembling a bundle for them would
 *     be pure waste.
 *   - `autofix-test-writer` — `rectify` is an implementer-role stage
 *     (stage-config.ts). A test-writer op under it would receive
 *     implementer-audience chunks. Giving it a correct stage is a separate,
 *     deferred decision.
 */
const RECTIFICATION_STAGE_MAP: Readonly<Record<string, StageKey>> = {
  "autofix-implementer": "rectify",
  "full-suite-rectify": "rectify",
  "repo-scoped-test-fix": "rectify",
  implementer: "rectify",
};

/** Options for {@link contextStageForOp}. */
export interface ContextStageForOpOptions {
  /** True under three-session (TDD) strategies. Ignored when `inRectification` is true and matches. */
  isThreeSession?: boolean;
  /** True when the op is dispatched inside the rectification fix cycle (rectification.ts). */
  inRectification?: boolean;
}

/**
 * Resolve the context-engine stage key for a dispatched op, or `undefined`
 * when the op keeps whatever bundle `ctx.contextBundle` already carries
 * (Phase A's non-regression guarantee).
 *
 * `inRectification` is consulted FIRST and takes precedence over the
 * three-session branch: the fix cycle re-uses op names (`implementer`) that
 * also run under CANONICAL_ORDER, but inside the cycle they are doing
 * rectification work, not TDD-session work.
 */
export function contextStageForOp(opName: string, opts: ContextStageForOpOptions = {}): StageKey | undefined {
  const { isThreeSession = false, inRectification = false } = opts;
  if (inRectification) {
    const rectificationStage = RECTIFICATION_STAGE_MAP[opName];
    if (rectificationStage) return rectificationStage;
  }
  if (isThreeSession) {
    const threeSessionStage = THREE_SESSION_STAGE_MAP[opName];
    if (threeSessionStage) return threeSessionStage;
  }
  return UNCONDITIONAL_STAGE_MAP[opName];
}

/** Options for {@link executionContextStage}. */
export interface ExecutionContextStageOptions {
  /** True when the pipeline is assembling a batch (multi-story) prompt. */
  isBatch: boolean;
  /** The story's resolved test strategy, if known. */
  testStrategy?: TestStrategy;
}

/**
 * Resolve the context-engine stage key for the single-session execution
 * seam (promptStage, src/pipeline/stages/prompt.ts) — the execution-side
 * sibling of {@link contextStageForOp}, which covers the story-phase
 * (run-phase.ts) dispatch seam instead.
 *
 * `test-after` and any unrecognized `testStrategy` value fall back to
 * `single-session` — there is no dedicated stage-config entry for
 * `test-after`, and it behaves identically to the plain single-session path.
 */
export function executionContextStage(opts: ExecutionContextStageOptions): StageKey {
  const { isBatch, testStrategy } = opts;
  if (isBatch) return "batch";
  if (testStrategy === "no-test") return "no-test";
  if (testStrategy === "tdd-simple") return "tdd-simple";
  return "single-session";
}
