import { getSafeLogger } from "../logger";
import { findMissingVerbatimAcs, findSpecDriftViolations } from "../prd";
import type { PRD } from "../prd/types";

/**
 * Soft gate shared by the plan ops (single + refine): warn — loudly, structured
 * — when a `[verbatim]` spec AC did not survive into the PRD. Paraphrasing a
 * verbatim grep / file-check / invariant destroys its verification mechanism
 * (docs/findings/nax-plan-prd-fidelity.md), but `nax plan` is intentionally
 * recovery-tolerant: it always produces a usable PRD rather than failing. The
 * warning is the residual-drift signal, and spec-review remains the explicit
 * gate before any story executes. Refine additionally attempts a same-session
 * self-heal turn before this check; single is one-shot, so this warning is its
 * only verbatim signal.
 */
export function warnOnDroppedVerbatimAcs(prd: PRD, specContent: string, featureName: string): void {
  const missing = findMissingVerbatimAcs(specContent, prd);
  if (missing.length > 0) {
    getSafeLogger()?.warn(
      "plan",
      "[verbatim] spec acceptance criteria dropped from PRD — run spec-review --prd before executing",
      { featureName, missingCount: missing.length, missing },
    );
  }
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
