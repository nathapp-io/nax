import { getSafeLogger } from "../logger";
import { findMissingVerbatimAcs } from "../prd";
import type { PRD } from "../prd/types";

/**
 * Soft gate shared by the plan ops (single + refine): warn — loudly, structured
 * — when a `[verbatim]` spec AC did not survive into the PRD. Paraphrasing a
 * verbatim grep / file-check / invariant destroys its verification mechanism
 * (docs/findings/nax-plan-prd-fidelity.md), but `nax plan` is intentionally
 * recovery-tolerant: it always produces a usable PRD rather than failing. The
 * warning is the residual-drift signal, and spec-review Phase 9 remains the
 * explicit gate before any story executes. Refine additionally attempts a
 * same-session self-heal turn before this check; single is one-shot, so this
 * warning is its only verbatim signal.
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
