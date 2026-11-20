/**
 * B1 (bot-reviewed-head): an earlier review's summary-only findings.
 *
 * A review narrows its range to the commits after the reviewed head, so its verdict says nothing about
 * the findings an earlier review raised inside the range it skips. A finding with an inline thread is
 * carried anyway — `mergeEarlier` re-reads the threads — but a finding the reviewer gave no line for (or
 * whose inline write failed) has no thread, and the earlier review's artifact is its only record.
 *
 * Carrying those forward by key is what keeps them open: the new review lists them in its summary and
 * records them in its artifact, so a readiness pass at the new head still holds on them (B1). Without
 * it, advancing the reviewed head past such a review released the finding from readiness while nothing
 * had fixed it.
 *
 * Only a review that skips the reviewed head's own changes carries: an incremental one whose range base
 * is that head. A full review re-reads the whole range, so its verdict is the newer word on them.
 */
import { DEFAULT_BLOCKING_TRIGGERS, isBlockingFinding } from "@/workflow/blocking-findings";
import type { ItemIndex } from "../workflow/item-threads";
import type { AgreedItem, BotReviewArtifact, PostReviewInput } from "./post";
import { findingKey } from "./render";
import type { BotReviewScope } from "./review-rulings";

/** A finding an earlier review recorded without a thread to hang it on. */
export type CarriedFinding = Extract<AgreedItem, { readonly kind: "finding" }>;

/**
 * What ends a carry is a newer word on the same key: this review reports it itself, a thread owns it
 * (so `mergeEarlier` carries it as a thread), an authorized ruling settled it, or a recorded bot push
 * claims to have fixed it. Only blocking findings travel — nothing else holds readiness, and every
 * later summary would otherwise grow for nothing.
 */
export function carriedOpen(input: PostReviewInput): CarriedFinding[] {
  const earlier = input.carriedFindings ?? [];
  if (earlier.length === 0) return [];
  const blocking = input.blockingTriggers ?? DEFAULT_BLOCKING_TRIGGERS;
  const raised = new Set(input.verdict.findings.map(findingKey));
  const threaded = new Set(input.own.flatMap(({ key, threadId }) => (threadId === undefined ? [] : [key])));
  const pushed = new Set((input.botPushes ?? []).flatMap(({ items }) => items.map(({ key }) => key)));
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
  prNumber: number,
  headSha: string,
  options?: { readonly codeOnly?: boolean },
) => Promise<BotReviewArtifact | null>;

export interface EarlierCarriedInput {
  readonly outputDir: string;
  readonly pr: number;
  /** The index this review read at preparation; its `reviewedHead` names the earlier review. */
  readonly index?: ItemIndex | undefined;
  readonly scope: BotReviewScope;
  readonly rangeBase: string;
  readonly load: LoadReview;
}

/**
 * The findings the review of the reviewed head recorded, read back from that review's artifact.
 *
 * Nothing is carried when the artifact is not on this machine — another host ran the earlier review —
 * which is the behaviour before this carry existed: readiness simply has nothing to hold on.
 */
export async function earlierCarriedFindings(input: EarlierCarriedInput): Promise<readonly CarriedFinding[]> {
  const reviewedHead = input.index?.reviewedHead;
  if (reviewedHead === undefined) return [];
  if (input.scope !== "incremental" || input.rangeBase !== reviewedHead) return [];
  const earlier = await input.load(input.outputDir, input.pr, reviewedHead, { codeOnly: true });
  if (earlier === null) return [];
  return earlier.agreed.filter((item) => item.kind === "finding");
}
