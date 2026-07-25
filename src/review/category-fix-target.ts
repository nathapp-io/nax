import type { FixTarget } from "../findings/types";
import { BLOCKING_CATEGORIES } from "./ac-structural-counterfactual";

/**
 * Maps an adversarial finding category to the fix lane that owns it.
 * SSOT: the "source" set IS `BLOCKING_CATEGORIES` — never a hand-copied list.
 * `convention` and any unrecognized category default to "test" (conservative:
 * the implementer never receives an ambiguous/unknown finding for un-reviewed
 * source editing).
 */
export function categoryToFixTarget(category: string | undefined): FixTarget {
  // "out-of-scope" is not a blocking category (scope findings are advisory), but
  // if `review.blockingThreshold` is lowered to "warning" it would otherwise fall
  // through to the test-writer. "You implemented excluded work" is a source-side
  // problem — the fix is removing code, never writing a test.
  if (category === "out-of-scope") return "source";
  return category != null && BLOCKING_CATEGORIES.has(category) ? "source" : "test";
}
