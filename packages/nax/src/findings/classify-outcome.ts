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
import { findingRecurrenceKey } from "./types";

/** Classify the outcome of a single iteration for one finding source. Uses findingRecurrenceKey (excludes message) so a reworded finding doesn't read as a spurious regression (nax#1581). */
function classifySingleSource<F extends Finding>(before: F[], after: F[]): IterationOutcome {
  const beforeKeys = new Set(before.map(findingRecurrenceKey));
  const afterKeys = new Set(after.map(findingRecurrenceKey));

  if (afterKeys.size === 0 && beforeKeys.size === 0) return "resolved";
  if (afterKeys.size === 0) return "resolved";

  // Check for new findings (regression)
  const hasNew = [...afterKeys].some((k) => !beforeKeys.has(k));
  const hasResolved = [...beforeKeys].some((k) => !afterKeys.has(k));

  if (hasNew && !hasResolved) return "regressed";
  if (!hasNew && !hasResolved) return "unchanged";
  if (hasNew && hasResolved) return "regressed"; // new ones appeared even if some resolved
  return "partial"; // hasResolved && !hasNew
}

/**
 * Classify an iteration outcome by computing per-source outcomes then
 * aggregating. Mixed cross-source comparisons are avoided: e.g. if before has
 * [lintA] and after has [typecheckC], that surfaces as "regressed-different-source"
 * because the lint source resolved but a new source appeared.
 */
export function classifyOutcome<F extends Finding>(before: F[], after: F[]): IterationOutcome {
  if (before.length === 0 && after.length === 0) return "resolved";
  // No prior findings — any new finding is a plain regression, not a source-switch.
  if (before.length === 0) return "regressed";

  const beforeSources = new Set(before.map((f) => f.source));
  const afterSources = new Set(after.map((f) => f.source));

  // Detect new sources appearing that weren't in before
  const newSources = [...afterSources].filter((s) => !beforeSources.has(s));
  if (newSources.length > 0) return "regressed-different-source";

  // nax#2154: every finding replaced by a different one — the defect moved, nothing converged.
  const beforeKeys = new Set(before.map(findingRecurrenceKey));
  if (after.length > 0 && after.every((f) => !beforeKeys.has(findingRecurrenceKey(f)))) return "rotated";

  // Compute per-source outcomes for sources that existed before
  const sources = [...beforeSources];
  const perSource = sources.map((source) =>
    classifySingleSource(
      before.filter((f) => f.source === source),
      after.filter((f) => f.source === source),
    ),
  );

  if (perSource.every((o) => o === "resolved")) return "resolved";
  if (perSource.some((o) => o === "regressed")) return "regressed";
  if (perSource.every((o) => o === "unchanged")) return "unchanged";
  return "partial";
}
