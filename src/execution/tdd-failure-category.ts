import type { Finding } from "../findings/types";
import { fullSuiteGateOp, greenfieldGateOp, implementerOp, testWriterOp, verifierOp } from "../operations";
import { EXHAUSTED_EXIT_REASONS } from "./story-orchestrator";
import type { FailureCategory } from "./types";

/** Derive TDD failure category from phase outputs after plan.run(). */
export function deriveTddFailureCategory(
  phaseOutputs: Record<string, unknown>,
  unfixedFindings?: readonly Finding[],
  gateRegressedDuringRect?: boolean,
  missingRequiredReviewPhases?: readonly string[],
): FailureCategory | undefined {
  // A configured review phase never ran (e.g. the resume loop broke at a red gate
  // before reaching it). Checked FIRST so it outranks the verifier-SSOT carve-out
  // below — an unreviewed story must not be exempted into a pass. Routed to
  // escalation by `routeTddFailure` so a stronger tier can green the gate and run
  // the review; terminal only after escalation is exhausted (US-002).
  if (missingRequiredReviewPhases && missingRequiredReviewPhases.length > 0) {
    return "review-incomplete";
  }

  // Test-writer failure → session-failure
  const testWriterOutput = phaseOutputs[testWriterOp.name] as { success?: boolean } | undefined;
  if (testWriterOutput?.success === false) {
    return "session-failure";
  }

  // Greenfield gate: when success=false + pauseReason="greenfield-no-tests", the pause
  // handler in extractPauseReason fires first. deriveTddFailureCategory also checks it so
  // the failureCategory is set correctly for non-pause paths (e.g. tests that bypass pause).
  const greenfieldOutput = phaseOutputs[greenfieldGateOp.name] as
    | { success?: boolean; pauseReason?: string }
    | undefined;
  if (greenfieldOutput?.success === false && greenfieldOutput?.pauseReason === "greenfield-no-tests") {
    return "greenfield-no-tests";
  }

  // Verifier failure → derive from verifier output
  const verifierOutput = phaseOutputs[verifierOp.name] as { success?: boolean; failureCategory?: string } | undefined;
  if (verifierOutput?.success === false) {
    if (verifierOutput.failureCategory) {
      return verifierOutput.failureCategory as FailureCategory;
    }
    return "tests-failing";
  }

  // Verifier passed → it is the SSOT for the TDD verdict. Even if the gate flagged
  // failures, the verifier has judged this story OK (e.g. unrelated regressions).
  // Skip the gate-derived category in that case — UNLESS rectification introduced
  // new gate failures after the verifier ran, which makes the verdict stale (the
  // story is failed for exactly this reason; route it to escalation as a gate
  // failure rather than dropping the category). Mirrors the success-aggregation
  // staleness guard in ExecutionPlan.run.
  const verifierPassed = verifierOutput?.success === true && !gateRegressedDuringRect;

  // Full-suite gate exhausted: rectification ran out of retry budget AND at least
  // one test-runner finding remains unfixed. Takes priority over the plain
  // tests-failing branch below, but only fires when verifier did NOT pass (the
  // verifierPassed guard above already short-circuits when verifier succeeded).
  if (!verifierPassed && unfixedFindings && unfixedFindings.length > 0) {
    const rectOutput = phaseOutputs.rectification as { exitReason?: string } | undefined;
    if (
      rectOutput?.exitReason &&
      EXHAUSTED_EXIT_REASONS.has(rectOutput.exitReason) &&
      unfixedFindings.some((f) => f.source === "test-runner")
    ) {
      return "full-suite-gate-exhausted";
    }
  }

  // Mid-rectification crash: validator infrastructure threw during re-validation.
  // runFixCycle sets exitReason "validator-error" when runPhase throws (story-orchestrator.ts:932).
  // Distinct from EXHAUSTED_EXIT_REASONS — the crash, not budget exhaustion, is the root cause.
  if (!verifierPassed) {
    const rectOutputCrash = phaseOutputs.rectification as { exitReason?: string } | undefined;
    if (rectOutputCrash?.exitReason === "validator-error") {
      return "runtime-crash";
    }
  }

  // Full-suite gate failure without an overriding verifier verdict → tests-failing.
  // Reached only when verifier either failed-without-category-but-handled-above, did
  // not run, or has no output. Routed by `routeTddFailure` as `escalate` (same
  // handling as a verifier-derived tests-failing). Distinct from
  // `full-suite-gate-exhausted`, which fires only after rectification retries spent.
  if (!verifierPassed) {
    const gateOutput = phaseOutputs[fullSuiteGateOp.name] as { success?: boolean; passed?: boolean } | undefined;
    if (gateOutput && (gateOutput.success === false || gateOutput.passed === false)) {
      return "tests-failing";
    }
  }

  // Implementer failure → session-failure
  const implOutput = phaseOutputs[implementerOp.name] as { success?: boolean } | undefined;
  if (implOutput?.success === false) {
    return "session-failure";
  }

  return undefined;
}
