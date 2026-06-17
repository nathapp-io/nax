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
  return category != null && BLOCKING_CATEGORIES.has(category) ? "source" : "test";
}
