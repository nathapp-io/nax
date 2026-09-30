/**
 * Dispatch one phase in rectification's validation sweep, pairing the two
 * reviews only when the complete selected sweep permits concurrent sessions.
 */
import type { Finding } from "@/findings";
import type { CallContext } from "@/operations";
import type { PhaseTracking } from "./execution-plan-phases";
import { extractPhaseFindings, phasePassed } from "./phase-eval";
import { runReviewPair, shouldRunReviewsConcurrently } from "./review-pair";
import { runPhase } from "./run-phase";
import type { InternalPhase, PhaseKind } from "./types";

/** Dispatch `phase` and return every phase kind dispatched by this call. */
export async function dispatchRevalidationPhase(
  ctx: CallContext,
  phase: InternalPhase,
  phases: readonly InternalPhase[],
  tracking: PhaseTracking,
  isThreeSession?: boolean,
): Promise<readonly PhaseKind[]> {
  const reviewConfig = ctx.config?.review ?? ctx.packageView.config.review;
  if (phase.kind === "semantic-review" && shouldRunReviewsConcurrently(reviewConfig, phases)) {
    const semantic = phase;
    const adversarial = phases.find((candidate) => candidate.kind === "adversarial-review");
    if (adversarial) {
      await runReviewPair(ctx, [semantic, adversarial], tracking, isThreeSession);
      return ["semantic-review", "adversarial-review"];
    }
  }
  await runPhase(ctx, phase.slot, tracking.phaseCosts, tracking.phaseOutputs, isThreeSession);
  return [phase.kind];
}

export function phasesForRevalidation(ctx: CallContext, phases: readonly InternalPhase[]): readonly InternalPhase[] {
  const reviewConfig = ctx.config?.review ?? ctx.packageView.config.review;
  return shouldRunReviewsConcurrently(reviewConfig, phases)
    ? phases.filter((phase) => phase.kind !== "adversarial-review")
    : phases;
}

export function collectPairedReviewFindings(options: {
  dispatched: readonly PhaseKind[];
  phases: readonly InternalPhase[];
  phaseOutputs: Record<string, unknown>;
  findings: Finding[];
  storyId: string | undefined;
}): boolean {
  if (options.dispatched.length < 2) return false;
  const phase = options.phases.find((item) => item.kind === "adversarial-review");
  if (!phase) return false;
  const output = options.phaseOutputs[phase.slot.op.name];
  options.findings.push(...extractPhaseFindings(output));
  return !phasePassed(phase.slot.op.name, output, options.storyId);
}

export function isRevalidationFailure(options: {
  phase: InternalPhase;
  output: unknown;
  storyId: string | undefined;
  quarantinedOnly: boolean;
  pairedReviewFailed: boolean;
}): boolean {
  return (
    (!phasePassed(options.phase.slot.op.name, options.output, options.storyId) && !options.quarantinedOnly) ||
    options.pairedReviewFailed
  );
}
