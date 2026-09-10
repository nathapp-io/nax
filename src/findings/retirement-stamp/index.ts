/**
 * Stamp shape and queries for the `meta.recurrence` field that US-001 writes
 * onto a `Finding` once `classifyRecurrence` has placed it in a terminal bucket
 * (`retired` / `demoted`). Two consumers read this shape today and MUST agree
 * on the exact guard:
 *
 *   - `src/prompts/builders/prior-iterations-builder.ts` uses it to move a
 *     finding out of the verdict-required list and into the acknowledgement
 *     section of the carry-forward prompt.
 *   - `src/execution/non-blocking-fix.ts` uses it to drop the finding from
 *     the actionability filter that seeds a paid fix pass.
 *
 * Centralising the predicate here means a future change to the stamp shape
 * (a renamed field, a different disposition value, a wrapper type) only has
 * to be made once. Each prior hand-rolled copy could drift and silently
 * de-synchronise the prompt from the fix lane.
 *
 * Pure / repo-scoped — no I/O, no config. Lives at its own nested barrel
 * (`@/findings/retirement-stamp`) so consumers that already sit inside the
 * `src/findings/index.ts → cycle.ts → operations/index.ts` cycle can import
 * the predicate without joining that cycle (see project-conventions nested
 * barrel rule).
 */

import { fingerprintFor } from "../fingerprint";
import type { Finding } from "../types";

/**
 * Disposition string the stamp may carry. Mirrors the union that
 * `classifyRecurrence` (`src/review/recurrence-demotion.ts`) writes; kept
 * inline here to avoid a value import through `@/review/recurrence-demotion`
 * from `src/prompts/...` (cycles), and to avoid re-importing the wider
 * `@/findings` barrel from `src/execution/...` (cycles).
 */
export type RecurrenceDisposition = "blocking" | "advisory" | "demoted" | "retired";

/**
 * The shape US-001 stamps onto `meta.recurrence`. Field names mirror
 * `stampRecurrence` in `src/review/recurrence-demotion.ts` exactly.
 */
export interface RecurrenceStamp {
  disposition: RecurrenceDisposition;
  rounds: number;
  wasBlocking?: boolean;
}

/**
 * Is this finding stamped with the terminal-advisory `retired` disposition?
 *
 * The guard tolerates the wide `Record<string, unknown>` shape that
 * `Finding.meta` is typed as. A drifted shape (e.g. a future version where
 * `recurrence` is a bare string rather than an object) returns false here
 * and the two consumers converge on a no-op, which is the safe direction —
 * the prompt will still render the finding, and the fix lane will still
 * dispatch; both are wrong only on the over-active side, never on the
 * missed-retirement side.
 */
export function isRecurrenceRetired(f: Finding): boolean {
  const rec = f.meta?.recurrence;
  return typeof rec === "object" && rec !== null && (rec as { disposition?: unknown }).disposition === "retired";
}

/**
 * Read the `disposition` of the stamp if one is present. Returns `undefined`
 * when the stamp is missing or malformed. Used by tests to assert the
 * shape the prompt / fix-lane branches key on.
 */
export function readRecurrenceDisposition(f: Finding): RecurrenceDisposition | undefined {
  const rec = f.meta?.recurrence;
  if (typeof rec !== "object" || rec === null) return undefined;
  const disp = (rec as { disposition?: unknown }).disposition;
  if (disp === "blocking" || disp === "advisory" || disp === "demoted" || disp === "retired") {
    return disp;
  }
  return undefined;
}

/**
 * Identity for "is THIS finding the same defect a retired stamp was written
 * for?" — `fingerprintFor` by another name.
 *
 * This is a THIN wrapper, deliberately: the identity that decides a finding is
 * retired (`classifyRecurrence` in `src/review/recurrence-demotion.ts`) and the
 * identity that suppresses the earlier-round / elsewhere copy of it must be the
 * same function, not two implementations that agree today. Both read
 * `@/findings/fingerprint`, the shared dependency-free module — a fork here
 * (even a faithful one, with a "keep in sync" comment) fails silently: the
 * prompt would keep a copy the classifier retired, or suppress one it did not,
 * and each copy's own tests would stay green.
 *
 * The `text` argument is the persisted `Finding.message`; the classifier passes
 * the wire-shape `issue`. Same field, same normaliser.
 */
export function retirementIdentity(f: Finding): string {
  const acIndex = typeof f.meta?.acIndex === "number" ? f.meta.acIndex : undefined;
  return fingerprintFor(f.file, f.category, f.message ?? "", acIndex);
}
