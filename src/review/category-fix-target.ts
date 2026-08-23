import type { FixTarget } from "../findings/types";
import { BLOCKING_CATEGORIES } from "./ac-structural-counterfactual";

/**
 * Maps an adversarial finding category to the fix lane that owns it.
 * SSOT: the "source" set IS `BLOCKING_CATEGORIES` — never a hand-copied list.
 * `convention` and any unrecognized category default to "test" (conservative:
 * the implementer never receives an ambiguous/unknown finding for un-reviewed
 * source editing). `null` and `undefined` both take that default — the `!= null`
 * guard below has always handled `null`, so the parameter type says so.
 */
export function categoryToFixTarget(category: string | null | undefined): FixTarget {
  // "out-of-scope" is not a blocking category (scope findings are advisory), but
  // if `review.blockingThreshold` is lowered to "warning" it would otherwise fall
  // through to the test-writer. "You implemented excluded work" is a source-side
  // problem — the fix is removing code, never writing a test.
  if (category === "out-of-scope") return "source";
  return category != null && BLOCKING_CATEGORIES.has(category) ? "source" : "test";
}

export interface ResolveFixTargetArgs {
  /**
   * The lane the producing subsystem would pick on its own — `categoryToFixTarget`
   * for adversarial findings, the constant `"source"` for semantic ones.
   */
  base: FixTarget;
  /** The finding's file, as reported by the reviewer (package-relative). */
  file?: string;
  /**
   * Test-file classifier built from `resolveTestFilePatterns` (ADR-009 SSOT).
   * Omit when patterns are unavailable — the base lane is then kept as-is.
   */
  isTestFile?: (path: string) => boolean;
}

/**
 * Path beats category (#1368).
 *
 * A finding located in a test file belongs to the test lane no matter what its
 * category says. Category is a weak proxy for "which lane owns this fix": a
 * resource-leak finding is `abandonment` whether it lives in `src/` or `test/`,
 * but only the test-writer can act on the second. Routing such a finding to
 * `autofix-implementer` — which is forbidden from editing test files — deadlocks
 * the fix cycle: the implementer emits `UNRESOLVED:` and the cycle exits
 * `agent-gave-up` with the finding untouched.
 *
 * The override is one-way. It can only move a finding toward the test lane,
 * never toward the implementer, so a missing or empty classifier degrades to
 * exactly today's behaviour rather than misrouting in the opposite direction.
 */
export function resolveFixTarget({ base, file, isTestFile }: ResolveFixTargetArgs): FixTarget {
  if (file && isTestFile?.(file)) return "test";
  return base;
}
