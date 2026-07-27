/**
 * Plan fidelity helpers shared by the plan ops (single + refine).
 *
 * `nax plan` is intentionally recovery-tolerant: it always produces a usable
 * PRD rather than failing. These helpers are the residual-drift signals —
 * deterministic backfill where a drop is repairable, a structured warning where
 * it is not. spec-review remains the explicit gate before any story executes.
 */
import { getSafeLogger } from "../logger";
import { applyOutOfScopeFallback, findMissingOutOfScope, findSpecDriftViolations } from "../prd";
import type { PRD } from "../prd/types";

/**
 * Scope-fidelity backfill shared by the plan ops (single + refine).
 *
 * Feature-level exclusions have exactly one home (`prd.outOfScope`), so unlike
 * a dropped AC — where restoring it would require knowing which story owns it —
 * a dropped exclusion can be repaired deterministically. The prompt asks the planner for its own wording; whatever
 * it drops is appended verbatim from the spec here, and the warning records
 * that the planner needed the safety net.
 *
 * Returns the backfilled PRD (the input reference when nothing was missing).
 */
export function backfillOutOfScope(prd: PRD, specContent: string, featureName: string): PRD {
  const missing = findMissingOutOfScope(specContent, prd);
  if (missing.length === 0) return prd;
  getSafeLogger()?.warn("plan", "Spec out-of-scope statements dropped from PRD — backfilled verbatim from the spec", {
    featureName,
    missingCount: missing.length,
    missing,
  });
  return applyOutOfScopeFallback(prd, specContent);
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
