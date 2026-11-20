/**
 * B1 (bot-reviewed-head): an earlier review's summary-only findings.
 *
 * A review narrows its range to the commits after the reviewed head, so its verdict says nothing about
 * the findings an earlier review raised inside the range it skips. A finding with an inline thread is
 * carried anyway — `mergeEarlier` re-reads the threads — but a finding the reviewer gave no line for (or
 * whose inline write failed) has no thread at all.
 *
 * Carrying those forward by key is what keeps them open: the new review lists them in its summary and
 * records them in its artifact, so a readiness pass at the new head still holds on them (B1). Without
 * it, advancing the reviewed head past such a review released the finding from readiness while nothing
 * had fixed it.
 *
 * Only a review that skips the reviewed head's own changes carries: an incremental one whose range base
 * is that head. A full review re-reads the whole range, so its verdict is the newer word on them.
 *
 * Where the record is read from:
 *
 * 1. the bot's own record comment for that head (`w-carry:<sha>`, `carried-record.ts`), written by the
 *    review of that head, so a review on another worker — or after this machine's artifacts were cleaned
 *    up — still sees it;
 * 2. else this machine's artifact, which older reviews wrote and no other worker has.
 *
 * B3: nothing here trusts what it reads. A record that does not parse, and an artifact whose findings are
 * not readable, produce `widen: true` rather than an exception or a silent empty carry: the caller then
 * reviews the whole range, which re-reads the very findings the missing record would have held.
 */
import type { OwnComment, PrRef } from "@/forge";
import type { WorkflowSeverity } from "@/operations";
import { DEFAULT_BLOCKING_TRIGGERS, isBlockingFinding } from "@/workflow/blocking-findings";
import type { ItemIndex } from "../workflow/item-threads";
import { type CarriedEntry, carriedRecordComment, parseCarriedRecord } from "./carried-record";
import type { AgreedItem, BotReviewArtifact, PostReviewInput } from "./post";
import { findingKey } from "./render";
import type { BotReviewScope } from "./review-rulings";

/** A finding an earlier review recorded without a thread to hang it on. */
export type CarriedFinding = Extract<AgreedItem, { readonly kind: "finding" }>;

/**
 * What ends a carry is a newer word on the same key: this review reports it itself, a thread owns it
 * (so `mergeEarlier` carries it as a thread), an authorized ruling settled it, or a bot push recorded
 * *after* the review that raised it claims to have fixed it. Only blocking findings travel — nothing
 * else holds readiness, and every later summary would otherwise grow for nothing.
 *
 * The push that ends a carry is `carriedFixPushes`, not the whole ledger (B1): a push made at or before
 * the review that reported the finding cannot have fixed it, and counting its key would release the
 * finding the review had just raised.
 */
export function carriedOpen(input: PostReviewInput): CarriedFinding[] {
  const earlier = input.carriedFindings ?? [];
  if (earlier.length === 0) return [];
  const blocking = input.blockingTriggers ?? DEFAULT_BLOCKING_TRIGGERS;
  const raised = new Set(input.verdict.findings.map(findingKey));
  const threaded = new Set(input.own.flatMap(({ key, threadId }) => (threadId === undefined ? [] : [key])));
  const pushed = new Set((input.carriedFixPushes ?? []).flatMap(({ items }) => items.map(({ key }) => key)));
  const kept: CarriedFinding[] = [];
  const seen = new Set<string>();
  for (const finding of earlier) {
    if (seen.has(finding.key) || !isBlockingFinding(finding, blocking)) continue;
    if (raised.has(finding.key) || threaded.has(finding.key) || pushed.has(finding.key)) continue;
    if (input.settledKeys?.has(finding.key) === true) continue;
    seen.add(finding.key);
    kept.push(finding);
  }
  return kept;
}

/** `loadLatestReview`, narrowed to what this module reads of it. */
export type LoadReview = (
  outputDir: string,
  ref: PrRef,
  headSha: string,
  options?: { readonly codeOnly?: boolean },
) => Promise<BotReviewArtifact | null>;

export interface EarlierCarriedInput {
  readonly outputDir: string;
  /** B4: the whole reference, so a shared output directory cannot hand this PR another repo's review. */
  readonly ref: PrRef;
  /** The index this review read at preparation; its `reviewedHead` names the earlier review. */
  readonly index?: ItemIndex | undefined;
  readonly scope: BotReviewScope;
  readonly rangeBase: string;
  /** The bot's own comments on the PR, where the durable record lives (B1). */
  readonly own: readonly OwnComment[];
  readonly load: LoadReview;
}

export interface CarriedRead {
  readonly findings: readonly CarriedFinding[];
  /** B3: a record exists for this head but no usable one does, so the review must widen its range. */
  readonly widen: boolean;
}

const NOTHING: CarriedRead = { findings: [], widen: false };

type RecordRead =
  | { readonly kind: "absent" }
  | { readonly kind: "usable"; readonly findings: readonly CarriedFinding[] }
  | { readonly kind: "unusable" };

function asCarried(entry: CarriedEntry): CarriedFinding {
  return { kind: "finding", ...entry };
}

/**
 * The record this head's review wrote, if the PR carries one. A body that does not parse is `unusable`:
 * something claims this head and cannot be read, which widens the review (B3).
 */
function readRecord(own: readonly OwnComment[], head: string): RecordRead {
  const comment = carriedRecordComment(own, head);
  if (comment === undefined) return { kind: "absent" };
  const record = parseCarriedRecord(comment.comment.body);
  if (record === null || record.headSha !== head) return { kind: "unusable" };
  return { kind: "usable", findings: record.findings.map(asCarried) };
}

function isSeverity(value: unknown): value is WorkflowSeverity {
  return value === "critical" || value === "important" || value === "minor";
}

/** One artifact finding, or undefined when it is not one a reviewer could have written. */
function readFinding(value: unknown): CarriedFinding | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const item = value as Record<string, unknown>;
  if (item.kind !== "finding" || typeof item.key !== "string" || item.key === "") return undefined;
  if (typeof item.issue !== "string" || !isSeverity(item.severity)) return undefined;
  return {
    kind: "finding",
    key: item.key,
    issue: item.issue,
    severity: item.severity,
    ...(typeof item.file === "string" ? { file: item.file } : {}),
    ...(typeof item.line === "number" && Number.isFinite(item.line) ? { line: item.line } : {}),
    ...(typeof item.suggestion === "string" ? { suggestion: item.suggestion } : {}),
  };
}

/**
 * B3: an artifact's findings, with every unusable entry skipped. A review that recorded finding items and
 * yields none of them is not a review that carried nothing — it is a record this reader cannot use, so
 * the caller widens instead of releasing what it could not read. The argument is `unknown` on purpose:
 * this is the seam where a damaged file is validated, so a caller may pass exactly what it decoded.
 */
export function carriedFromArtifact(agreed: unknown): CarriedRead {
  if (!Array.isArray(agreed)) return { findings: [], widen: true };
  const candidates = agreed.filter((item) => (item as { readonly kind?: unknown } | null)?.kind === "finding");
  const findings = candidates.flatMap((item) => {
    const finding = readFinding(item);
    return finding === undefined ? [] : [finding];
  });
  return { findings, widen: candidates.length > 0 && findings.length === 0 };
}

/**
 * The findings the review of the reviewed head left open, read back from the PR or this machine.
 *
 * Nothing is carried when neither holds a record — the workflow's own publish wrote that head, so no bot
 * review has anything to say about it — which is the behaviour before this carry existed.
 */
export async function earlierCarriedFindings(input: EarlierCarriedInput): Promise<CarriedRead> {
  const reviewedHead = input.index?.reviewedHead;
  if (reviewedHead === undefined) return NOTHING;
  if (input.scope !== "incremental" || input.rangeBase !== reviewedHead) return NOTHING;
  const record = readRecord(input.own, reviewedHead);
  if (record.kind === "usable") return { findings: record.findings, widen: false };
  if (record.kind === "unusable") return { findings: [], widen: true };
  const earlier = await input.load(input.outputDir, input.ref, reviewedHead, { codeOnly: true });
  return earlier === null ? NOTHING : carriedFromArtifact(earlier.agreed);
}
