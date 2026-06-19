import { NaxError } from "@/errors";
import type { AnySlot, InternalBuildState, InternalPhase, OrchestratorSlot, PhaseKind } from "./types";
import { CANONICAL_ORDER, PHASE_KIND_TO_STATE_KEY } from "./types";

export function isSlot<I, O, C>(value: unknown): value is OrchestratorSlot<I, O, C> {
  return (
    value !== null &&
    typeof value === "object" &&
    "op" in value &&
    "input" in value &&
    typeof (value as { op?: { kind?: string } }).op?.kind === "string"
  );
}

export function setPhase(state: InternalBuildState, kind: PhaseKind, slot: AnySlot): void {
  const key = PHASE_KIND_TO_STATE_KEY[kind];
  if (state[key] !== undefined) {
    throw new NaxError(
      `StoryOrchestratorBuilder: addX was called twice for phase "${kind}"`,
      "ORCHESTRATOR_PHASE_DUPLICATE",
      { stage: "execution", kind },
    );
  }
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous slot widened intentionally
  (state as any)[key] = { kind, slot };
}

export function collectOrderedPhases(state: InternalBuildState): InternalPhase[] {
  return CANONICAL_ORDER.flatMap((kind) => {
    if (kind === "test-writer" && state.testWriter) return [state.testWriter];
    if (kind === "greenfield-gate" && state.greenfieldGate) return [state.greenfieldGate];
    if (kind === "implementer" && state.implementer) return [state.implementer];
    if (kind === "full-suite-gate" && state.fullSuiteGate) return [state.fullSuiteGate];
    if (kind === "verifier" && state.verifier) return [state.verifier];
    if (kind === "verify-scoped" && state.verifyScoped) return [state.verifyScoped];
    if (kind === "lint-check" && state.lintCheck) return [state.lintCheck];
    if (kind === "typecheck-check" && state.typecheckCheck) return [state.typecheckCheck];
    if (kind === "semantic-review" && state.semanticReview) return [state.semanticReview];
    if (kind === "adversarial-review" && state.adversarialReview) return [state.adversarialReview];
    return [];
  });
}
