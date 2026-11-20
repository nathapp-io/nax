/**
 * What readiness reads from the bot's carried-findings state on the PR, beside the review artifact.
 *
 * Readiness reads the newest code-review artifact of the head. A `--full` rerun of an already-indexed head
 * writes that artifact before it knows whether its post completed, and an incomplete rerun keeps the head's
 * carried record rather than replacing it. So the artifact can omit a summary-only blocker that the record
 * still holds. The record on the PR is the durable statement of the head's blockers; readiness takes its
 * blocking keys too, and the caller settles them against the PR like any other key.
 *
 * Two states release nothing and hold instead (fail closed, as the carry reader widens): a record for the
 * head that does not parse, and a pending incomplete-review signal at any head.
 */
import type { OwnComment } from "@/forge";
import { type FindingTrigger, isBlockingFinding } from "@/workflow/blocking-findings";
import { carriedRecordComment, parseCarriedRecord, pendingCarryWidenComments } from "./carried-record";

export const CARRY_INCOMPLETE_HOLD =
  "carried finding coverage is incomplete; a complete full bot review (nax bot review --full) decides readiness";
export const CARRY_UNREADABLE_HOLD =
  "the carried findings record of this head cannot be read; a complete full bot review decides readiness";

export type CarriedReadiness =
  | { readonly kind: "keys"; readonly keys: readonly string[] }
  | { readonly kind: "held"; readonly reason: string };

/** The blocking keys the head's carried record holds, or the reason the carried state holds readiness. */
export function carriedReadiness(
  own: readonly OwnComment[],
  headSha: string,
  blocking: readonly FindingTrigger[],
): CarriedReadiness {
  if (pendingCarryWidenComments(own).length > 0) return { kind: "held", reason: CARRY_INCOMPLETE_HOLD };
  const comment = carriedRecordComment(own, headSha);
  if (comment === undefined) return { kind: "keys", keys: [] };
  const record = parseCarriedRecord(comment.comment.body);
  if (record === null || record.headSha !== headSha) return { kind: "held", reason: CARRY_UNREADABLE_HOLD };
  return {
    kind: "keys",
    keys: record.findings.filter((entry) => isBlockingFinding(entry, blocking)).map(({ key }) => key),
  };
}
