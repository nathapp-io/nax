/**
 * Iteration-outcome classification for the fix cycle (ADR-022).
 *
 * Extracted from `cycle.ts` (nax#2154): that module sat at 592 of its 600-line
 * cap, so `classifySingleSource` and `classifyOutcome` move here verbatim.
 * `cycle.ts` imports `classifyOutcome` for its own call sites and re-exports it
 * (`export { classifyOutcome } from "./classify-outcome";`) so every existing
 * import — including the `@/findings` barrel — keeps working.
 */

import type { IterationOutcome } from "./cycle-types";
import type { Finding } from "./types";

/**
 * Classify an iteration outcome by computing per-source outcomes then
 * aggregating. Mixed cross-source comparisons are avoided: e.g. if before has
 * [lintA] and after has [typecheckC], that surfaces as "regressed-different-source"
 * because the lint source resolved but a new source appeared.
 */
export function classifyOutcome<F extends Finding>(before: F[], after: F[]): IterationOutcome {
  void before; // STUB (nax#2154): the moved implementation replaces this body.
  void after;
  return "partial";
}
