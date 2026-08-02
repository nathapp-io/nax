/**
 * Plan fidelity helpers shared by the plan ops (single + refine).
 *
 * `nax plan` is intentionally recovery-tolerant: it always produces a usable
 * PRD rather than failing. These helpers are the residual-drift signals —
 * deterministic backfill where a drop is repairable, a structured warning where
 * it is not. spec-review remains the explicit gate before any story executes.
 */
import { getSafeLogger } from "../logger";
import {
  applyOutOfScopeFallback,
  demoteStoryScopedOutOfScope,
  findMissingOutOfScope,
  findSpecDriftViolations,
} from "../prd";
import type { PRD } from "../prd/types";

/**
 * Scope-fidelity repair shared by the plan ops (single + refine).
 *
 * Feature-level exclusions have exactly one home (`prd.outOfScope`), so unlike
 * a dropped AC — where restoring it would require knowing which story owns it —
 * both directions of drift are repairable deterministically:
 *
 * - **Over-hoisting** — a story-local `**Out of scope:**` block promoted to
 *   feature level is pushed back down onto its owning story (#1446). Runs first
 *   so the backfill's substring check sees the corrected list.
 * - **Dropping** — the prompt asks the planner for its own wording; whatever it
 *   drops is appended verbatim from the spec.
 *
 * Each warning records that the planner needed the safety net. Returns the input
 * reference when the PRD was already faithful.
 */
export function backfillOutOfScope(prd: PRD, specContent: string, featureName: string): PRD {
  const scoped = demoteStoryScopedOutOfScope(prd, specContent);
  if (scoped !== prd) {
    getSafeLogger()?.warn("plan", "Story-local out-of-scope blocks hoisted to feature level — demoted to their story", {
      featureName,
      hoistedCount: (prd.outOfScope ?? []).length - (scoped.outOfScope ?? []).length,
    });
  }

  const missing = findMissingOutOfScope(specContent, scoped);
  if (missing.length === 0) return scoped;
  getSafeLogger()?.warn("plan", "Spec out-of-scope statements dropped from PRD — backfilled verbatim from the spec", {
    featureName,
    missingCount: missing.length,
    missing,
  });
  return applyOutOfScopeFallback(scoped, specContent);
}

/**
 * Residual-drift warning for spec-guard: fires when the specGuard repair turn
 * did not eliminate all behavioral-fidelity violations. Non-fatal — the plan
 * continues with a warning so the user can manually correct or rerun.
 */
export function warnOnSpecDrift(prd: PRD, featureName: string): void {
  const violations = findSpecDriftViolations(prd);
  if (violations.length > 0) {
    getSafeLogger()?.warn("plan", "spec-drift violations remain after specGuard repair — review PRD before executing", {
      featureName,
      violationCount: violations.length,
      violations,
    });
  }
}
