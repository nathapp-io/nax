/**
 * Write the bot-owned carried-findings record after a review of a code range posts (B1).
 *
 * The comments that hold a finding — its inline thread, the summary — are on the PR already, and a later
 * review re-reads them. What they cannot hold is a finding's identity in a form a *machine* reads back
 * and matches: the summary is prose, and a finding the reviewer gave no line for has no thread at all.
 * This record is that machine-readable copy, written before the reviewed head can advance, so the next
 * review on any worker carries the finding instead of releasing it.
 *
 * What it records is what still needs holding: the carry this review kept, plus the blocking findings it
 * could only post in its summary. A finding a thread owns needs no record — `mergeEarlier` carries it from
 * the thread. Non-blocking findings are not recorded: nothing holds readiness on them.
 *
 * The answer is whether the reviewed head may advance. A record that could not be written, or one whose
 * budgets forced a finding out, leaves a finding with no durable record, so the head is held: the next
 * review then starts before this head and re-reads its changes rather than skipping them.
 */
import { errorMessage } from "@nathapp/nax-agent/internal";
import { editComment, type OwnComment, postPrComment, withNaxBotMarker } from "@/forge";
import { getLogger } from "@/logger";
import type { PrFinding } from "@/operations/bot-types";
import { DEFAULT_BLOCKING_TRIGGERS, isBlockingFinding } from "@/workflow/blocking-findings";
import { type CarriedFinding, carriedOpen } from "./carried-findings";
import {
  CARRY_WIDEN_CLEARED,
  type CarriedEntry,
  carriedRecordBody,
  carriedRecordComment,
  carriedRecordKey,
  carryWidenComment,
  carryWidenKey,
  carryWidenPending,
  pendingCarryWidenComments,
} from "./carried-record";
import { recordsCodeReview } from "./coverage-record";
import type { PostReviewInput } from "./post";
import { findingKey } from "./render";

function entryOf({ kind, ...entry }: CarriedFinding): CarriedEntry {
  return entry;
}

/** A blocking finding this review could not anchor: no thread owns it, so only a record can carry it. */
function offLineFinding(finding: PrFinding, key: string, raisedBy: string): CarriedFinding {
  return {
    kind: "finding",
    key,
    issue: finding.issue,
    severity: finding.severity,
    raisedBy,
    ...(finding.trigger === undefined ? {} : { trigger: finding.trigger }),
    ...(finding.triggerEvidence === undefined ? {} : { triggerEvidence: finding.triggerEvidence }),
    ...(finding.file === undefined ? {} : { file: finding.file }),
    ...(finding.line === undefined ? {} : { line: finding.line }),
    ...(finding.suggestion === undefined ? {} : { suggestion: finding.suggestion }),
  };
}

/** The findings the next review must still hold, in the order this review would list them. */
function carriedForRecord(input: PostReviewInput, offLine: readonly PrFinding[], reviewId: string): CarriedFinding[] {
  const blocking = input.blockingTriggers ?? DEFAULT_BLOCKING_TRIGGERS;
  const kept = [...carriedOpen(input)];
  const seen = new Set(kept.map(({ key }) => key));
  for (const finding of offLine) {
    const key = findingKey(finding);
    if (seen.has(key) || !isBlockingFinding(finding, blocking)) continue;
    seen.add(key);
    kept.push(offLineFinding(finding, key, reviewId));
  }
  return kept;
}

/** Whether the reviewed head may advance: true when the record this review needed landed whole. */
export async function postCarriedRecord(
  input: PostReviewInput,
  offLine: readonly PrFinding[],
  review: { readonly id: string; readonly complete: boolean },
): Promise<boolean> {
  if (!recordsCodeReview(input)) return true;
  const blocking = input.blockingTriggers ?? DEFAULT_BLOCKING_TRIGGERS;
  const hasNewBlocker = offLine.some((finding) => isBlockingFinding(finding, blocking));
  if (!review.complete) return !hasNewBlocker || writeCarryWiden(input, true);

  const findings = carriedForRecord(input, offLine, review.id);
  if (!(await replaceCarriedRecord(input, findings))) {
    if (hasNewBlocker) await writeCarryWiden(input, true);
    return false;
  }
  // Only a full verdict re-reads the whole range, so it supersedes every pending signal, whichever head
  // the incomplete review that left it was of.
  return input.scope !== "full" || clearCarryWidens(input);
}

async function clearCarryWidens(input: PostReviewInput): Promise<boolean> {
  let cleared = true;
  for (const own of pendingCarryWidenComments(input.own)) {
    if (!(await writeCarryWidenComment(input, { key: own.key, own, pending: false }))) cleared = false;
  }
  return cleared;
}

async function writeCarryWiden(input: PostReviewInput, pending: boolean): Promise<boolean> {
  const key = carryWidenKey(input.info.headSha);
  const own = carryWidenComment(input.own, input.info.headSha);
  if (pending === carryWidenPending(own)) return true;
  return writeCarryWidenComment(input, { key, own, pending });
}

async function writeCarryWidenComment(
  input: PostReviewInput,
  signal: { readonly key: string; readonly own: OwnComment | undefined; readonly pending: boolean },
): Promise<boolean> {
  const { key, own, pending } = signal;
  const text = pending
    ? "Carried finding coverage is incomplete. Review the full range before relying on this head."
    : CARRY_WIDEN_CLEARED;
  try {
    const body = withNaxBotMarker(text, key);
    if (own) await editComment(input.ref, own.comment, body, input.deps, input.cwd);
    else await postPrComment(input.ref, body, input.deps, input.cwd);
    return true;
  } catch (cause) {
    getLogger()?.warn("bot-post", "Could not update the full-review signal for carried findings", {
      pr: input.ref.number,
      error: errorMessage(cause),
    });
    return false;
  }
}

async function replaceCarriedRecord(input: PostReviewInput, findings: readonly CarriedFinding[]): Promise<boolean> {
  const { body, dropped } = carriedRecordBody({ headSha: input.info.headSha, findings: findings.map(entryOf) });
  if (dropped > 0) {
    getLogger()?.warn("bot-post", "Carried findings record exceeded its budget; holding the reviewed head", {
      pr: input.ref.number,
      dropped,
    });
    return false;
  }
  const own = carriedRecordComment(input.own, input.info.headSha);
  try {
    const marked = withNaxBotMarker(body, carriedRecordKey(input.info.headSha));
    if (own) await editComment(input.ref, own.comment, marked, input.deps, input.cwd);
    else await postPrComment(input.ref, marked, input.deps, input.cwd);
  } catch (cause) {
    getLogger()?.warn("bot-post", "Could not write the carried findings record", {
      pr: input.ref.number,
      error: errorMessage(cause),
    });
    // Only a new empty record can fail without leaving missing or stale findings.
    return own === undefined && findings.length === 0;
  }
  return true;
}
