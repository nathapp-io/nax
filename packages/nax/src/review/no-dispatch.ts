/**
 * Zero-dispatch review check results (US-002).
 *
 * `callOp` raises `CALL_OP_NO_DISPATCH` (code) when no hop of an operation ever
 * returned a turn — the model was never reached. The two review phases convert
 * that condition into a failed check result instead of propagating the dispatch
 * error, because a review that produced no verdict must block the story rather
 * than fail open.
 *
 * Scope: the conversion only. The producer of the error is `callOp` (US-001);
 * the consumer that records the phase output is the story orchestrator.
 */

import { NaxError } from "../errors";
import type { ReviewCheckName, ReviewCheckResult } from "./types";

/**
 * The error code `callOp` raises for a zero-dispatch operation. Spelled here
 * because this module is the only place that *reads* it — every producer in
 * `src/operations/call.ts` writes the same literal.
 */
const NO_DISPATCH_ERROR_CODE = "CALL_OP_NO_DISPATCH";

/**
 * Review phases, keyed by operation name, and the check name their result
 * reports. The same two review operations are what `findingsToFailedChecks`
 * (src/operations/_finding-to-check.ts) maps from their finding `source`, but
 * that map keys finding producers, not phase names — a distinct concept.
 */
const REVIEW_OP_CHECK_NAMES: Record<string, ReviewCheckName> = {
  "semantic-review": "semantic",
  "adversarial-review": "adversarial",
};

/**
 * Build the failed check result for a review phase whose dispatch never reached
 * a model.
 *
 * Returns `null` when `opName` is not one of the review phases or `err` is not
 * the zero-dispatch error, so the caller rethrows everything else unchanged.
 *
 * `noDispatch: true` accompanies `success: false` and never `failOpen: true` —
 * see `ReviewCheckResult.noDispatch` for why the two are mutually exclusive.
 */
export function toNoDispatchCheckResult(opName: string, err: unknown, durationMs: number): ReviewCheckResult | null {
  const check = REVIEW_OP_CHECK_NAMES[opName];
  if (!check) return null;
  if (!(err instanceof NaxError) || err.code !== NO_DISPATCH_ERROR_CODE) return null;

  return {
    check,
    success: false,
    noDispatch: true,
    failOpen: false,
    // A review that never ran has no command, no findings and no verdict — only
    // the dispatch failure itself is carried, so the run log and the audit
    // record name the cause instead of an empty check.
    command: "",
    exitCode: 1,
    output: err.message,
    durationMs,
    findings: [],
  };
}
