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
import { editComment, hasNaxWorkflowMarker, postPrComment, withNaxBotMarker } from "@/forge";
import { getLogger } from "@/logger";
import type { WorkflowFindingDraft } from "@/operations/workflow-types";
import { DEFAULT_BLOCKING_TRIGGERS, isBlockingFinding } from "@/workflow/blocking-findings";
import { type CarriedFinding, carriedOpen } from "./carried-findings";
import { type CarriedEntry, carriedRecordBody, carriedRecordComment, carriedRecordKey } from "./carried-record";
import type { PostReviewInput } from "./post";
import { findingKey } from "./render";

function entryOf({ key, severity, issue, file, line, suggestion }: CarriedFinding): CarriedEntry {
  return {
    key,
    severity,
    issue,
    ...(file === undefined ? {} : { file }),
    ...(line === undefined ? {} : { line }),
    ...(suggestion === undefined ? {} : { suggestion }),
  };
}

/** A blocking finding this review could not anchor: no thread owns it, so only a record can carry it. */
function offLineFinding(finding: WorkflowFindingDraft, key: string): CarriedFinding {
  return {
    kind: "finding",
    key,
    issue: finding.issue,
    severity: finding.severity,
    ...(finding.file === undefined ? {} : { file: finding.file }),
    ...(finding.line === undefined ? {} : { line: finding.line }),
    ...(finding.suggestion === undefined ? {} : { suggestion: finding.suggestion }),
  };
}

/** The findings the next review must still hold, in the order this review would list them. */
export function carriedForRecord(input: PostReviewInput, offLine: readonly WorkflowFindingDraft[]): CarriedFinding[] {
  const blocking = input.blockingTriggers ?? DEFAULT_BLOCKING_TRIGGERS;
  const kept = [...carriedOpen(input)];
  const seen = new Set(kept.map(({ key }) => key));
  for (const finding of offLine) {
    const key = findingKey(finding);
    if (seen.has(key) || !isBlockingFinding(finding, blocking)) continue;
    seen.add(key);
    kept.push(offLineFinding(finding, key));
  }
  return kept;
}

/**
 * Only a review that read code of a workflow PR has a range whose skipped part needs carrying: a static
 * review reads nothing by choice, and a conversation-only review owes no file a look.
 */
function recordsCarry(input: PostReviewInput): boolean {
  if (input.staticMode || input.scope === "conversation-only") return false;
  return hasNaxWorkflowMarker(input.info.body);
}

/** Whether the reviewed head may advance: true when the record this review needed landed whole. */
export async function postCarriedRecord(
  input: PostReviewInput,
  offLine: readonly WorkflowFindingDraft[],
): Promise<boolean> {
  if (!recordsCarry(input)) return true;
  const findings = carriedForRecord(input, offLine);
  const { body, dropped } = carriedRecordBody({ headSha: input.info.headSha, findings: findings.map(entryOf) });
  if (dropped > 0) {
    getLogger()?.warn("bot-post", "Carried findings record exceeded its budget; holding the reviewed head", {
      pr: input.ref.number,
      dropped,
    });
  }
  try {
    const marked = withNaxBotMarker(body, carriedRecordKey(input.info.headSha));
    const own = carriedRecordComment(input.own, input.info.headSha);
    if (own) await editComment(input.ref, own.comment, marked, input.deps, input.cwd);
    else await postPrComment(input.ref, marked, input.deps, input.cwd);
  } catch (cause) {
    getLogger()?.warn("bot-post", "Could not write the carried findings record", {
      pr: input.ref.number,
      error: errorMessage(cause),
    });
    // A record with nothing in it loses nothing when the write fails; an advance on it is still safe.
    return findings.length === 0 && dropped === 0;
  }
  return dropped === 0;
}
