import { join } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { NaxError } from "@/errors";
import type { ForgeDeps, OwnComment, PrComment, PrInfo, PrRef, PrThread } from "@/forge";
import {
  editComment,
  hasNaxWorkflowMarker,
  postInlineComment,
  postPrComment,
  replyToThread,
  unresolveThread,
  withNaxBotMarker,
} from "@/forge";
import { getLogger } from "@/logger";
import type { PrFinding, PrReviewVerdict, PrTriageDecision } from "@/operations/bot-types";
import type { WorkflowFindingDraft, WorkflowSeverity } from "@/operations/workflow-types";
import type { EffectiveBlockingTriggers, FindingTrigger } from "@/workflow/blocking-findings";
import { DEFAULT_BLOCKING_TRIGGERS, isBlockingFinding, readFindingThreadFacts } from "@/workflow/blocking-findings";
import type { CiWaitResult } from "../workflow/ci-wait";
import type { CallerRulingsReport } from "./caller-rulings";
import type { BotChecks } from "./checks";
import { COVERAGE_RECORD_KEY, renderCoverageRecord } from "./coverage-record";
import { earlierCounts, earlierIssue, effectiveEarlier, postEarlier, withdrawalEvents } from "./post-earlier";
import type { FindingLineage } from "./push-ledger";
import { commentKey, findingKey, threadKey } from "./render";
import { renderFindingComment, renderReviewSummary, renderThreadReply } from "./render-comments";
import type { BotReviewScope, ConfirmedItem, ItemStatus } from "./review-rulings";

interface AgreedBase {
  readonly key: string;
  readonly issue: string;
}
interface AgreedLocation {
  readonly file?: string;
  readonly line?: number;
}
export type AgreedItem =
  | (AgreedBase &
      AgreedLocation & {
        readonly kind: "finding";
        readonly severity: WorkflowSeverity;
        readonly suggestion?: string;
        readonly decision?: string;
        /** US-001: the class of condition the finding needs; absent on artifacts written before it. */
        readonly trigger?: FindingTrigger;
        readonly triggerEvidence?: string;
        /** US-004/US-005: the push whose lines the finding sits on; absent before any lineage read. */
        readonly lineage?: FindingLineage;
        /** US-005: the lineage of this finding could not be read, which is not the same as none. */
        readonly lineageUnknown?: true;
      })
  | (AgreedBase &
      AgreedLocation & {
        readonly kind: "thread";
        readonly reason: string;
        readonly threadId: string;
        readonly replyTo: string;
      })
  | (AgreedBase & { readonly kind: "comment"; readonly reason: string });

export interface BotReviewEvent {
  readonly type: "finding-withdrawn";
  readonly key: string;
  readonly threadId: string;
  readonly file?: string;
  readonly line?: number;
  readonly finding: string;
  readonly reason: string;
  /** Unverified forge logins; consumers must check artifact trust and commenter permissions. */
  readonly disagreedBy: readonly string[];
}

export interface BotReviewArtifact {
  readonly version: 1 | 2 | 3;
  readonly rulings?: PostReviewInput["rulings"];
  /** What a `--rulings` file did; absent when the flag was not given. */
  readonly callerRulings?: CallerRulingsReport;
  /** What the review actually covered (nax#2667); optional to every earlier reader. */
  readonly scope?: BotReviewScope;
  readonly incrementalSince?: string;
  readonly checks?: BotChecks | null;
  readonly events?: readonly BotReviewEvent[];
  readonly pr: PrRef;
  readonly headSha: string;
  /** Diagnostic only; not an authorization decision for fixes. */
  readonly trusted: boolean;
  readonly intent: PrReviewVerdict["intent"];
  /** `not-reviewed` when the review read no code (US-001); the verdict's own quality otherwise. */
  readonly quality: PrReviewVerdict["quality"] | "not-reviewed";
  readonly agreed: readonly AgreedItem[];
  /**
   * The set that decided this review's posting (US-003). Absent on artifacts written before it existed, so a
   * reader falls back to `bot.blockingTriggers`.
   */
  readonly blockingTriggers?: readonly FindingTrigger[];
}
export interface PostReviewInput {
  readonly itemStatus?: ItemStatus;
  readonly writers?: ReadonlySet<string>;
  readonly settledKeys?: ReadonlySet<string>;
  readonly resolvedThreadIds?: ReadonlySet<string>;
  readonly unreadFiles?: readonly string[];
  readonly preRunFailed?: string;
  /** The build step that failed after a successful install; the review still ran (US-007). */
  readonly buildFailed?: string;
  /** CI's verdict on the reviewed head (nax#2631). */
  readonly ci?: CiWaitResult;
  readonly earlier?: readonly PrThread[];
  readonly itemEarlier?: readonly PrThread[];
  readonly itemConfirmed?: readonly ConfirmedItem[];
  /** Fail closed on fixed workflow items when the review read non-writer comments. */
  readonly itemFixedBlocked?: boolean;
  readonly rulings?: { recorded: number; open: number; asked: number };
  readonly callerRulings?: CallerRulingsReport;
  /** What the review actually covered (nax#2667); absent when the caller does not classify it. */
  readonly scope?: BotReviewScope;
  /** The already-reviewed head an incremental review starts after. */
  readonly incrementalSince?: string;
  readonly login?: string;
  readonly checks?: BotChecks | null;
  readonly ref: PrRef;
  readonly info: PrInfo;
  readonly verdict: PrReviewVerdict;
  readonly threads: readonly PrThread[];
  readonly comments: readonly PrComment[];
  readonly own: readonly OwnComment[];
  readonly staticMode: boolean;
  readonly sensitive: readonly string[];
  /**
   * The effective blocking set (US-003): a critical or important finding outside it gets no inline thread.
   * Absent keeps the configured default, so a legacy caller posts as it did.
   */
  readonly blockingTriggers?: readonly FindingTrigger[];
  /** Where that set came from: a writer's scope ruling, or the config. */
  readonly blockingSource?: EffectiveBlockingTriggers["source"];
  /** The first line of every writer scope comment that stated no usable class (US-003). */
  readonly ignoredScopeRulings?: readonly string[];
  readonly stateDir: string;
  readonly deps: ForgeDeps;
  readonly cwd: string;
}
export interface PostReviewOutcome {
  readonly earlierAnswered: number;
  readonly inlineFindings: number;
  readonly threadsAnswered: number;
  readonly commentsAnswered: number;
  readonly offLine: number;
  readonly failed: number;
}

export const BOT_REVIEW_FILENAME = "bot-review.json";

/**
 * What a review may honestly report about code quality (US-001). A conversation-only review read no code,
 * so it reports `not-reviewed` rather than the verdict's own quality, which its prompt could not have earned.
 */
export function reviewQuality(
  scope: BotReviewScope | undefined,
  quality: PrReviewVerdict["quality"],
): BotReviewArtifact["quality"] {
  return scope === "conversation-only" ? "not-reviewed" : quality;
}

export const _postDeps = {
  writeArtifact: (path: string, artifact: BotReviewArtifact): Promise<number> =>
    Bun.write(path, `${JSON.stringify(artifact, null, 2)}\n`),
};

/** Only an agreeing, existing non-writer target warrants an explanation. */
function notQueued(input: PostReviewInput, decision: PrTriageDecision, comment: PrComment | undefined): boolean {
  return decision === "agree" && comment !== undefined && !input.writers?.has(comment.author);
}

function agreedItems(input: PostReviewInput): AgreedItem[] {
  const items: AgreedItem[] = input.verdict.findings
    .filter((finding) => !input.settledKeys?.has(findingKey(finding)))
    .map(({ severity, issue, file, line, suggestion, decision, trigger, triggerEvidence }) => ({
      key: findingKey({ file, issue }),
      kind: "finding",
      severity,
      issue,
      file,
      line,
      suggestion,
      ...(decision === undefined ? {} : { decision }),
      ...(trigger === undefined ? {} : { trigger }),
      ...(triggerEvidence === undefined ? {} : { triggerEvidence }),
    }));
  for (const verdict of input.verdict.threads) {
    if (verdict.decision !== "agree") continue;
    const thread = input.threads.find(({ id }) => id === verdict.id);
    const opener = thread?.comments[0];
    if (!thread || !opener || !input.writers?.has(opener.author)) continue;
    items.push({
      key: threadKey(thread.id),
      kind: "thread",
      issue: opener.body,
      reason: verdict.reason,
      threadId: thread.id,
      replyTo: thread.replyTo,
      file: thread.path,
      line: thread.line,
    });
  }
  for (const verdict of input.verdict.comments) {
    if (verdict.decision !== "agree") continue;
    const comment = input.comments.find(({ id }) => id === verdict.id);
    if (!comment || !input.writers?.has(comment.author)) continue;
    items.push({ key: commentKey(comment.id), kind: "comment", issue: comment.body, reason: verdict.reason });
  }
  return mergeEarlier(input, items);
}

const TRIGGER_LINE = "Trigger:";

/**
 * US-002: the trigger class an earlier finding's first comment states, or undefined when it states
 * none. The class itself is read by the shared `readFindingThreadFacts`; an old thread written before
 * the vocabulary existed keeps an absent trigger so it still blocks as it did.
 */
function earlierTrigger(body: string): FindingTrigger | undefined {
  const states = body.split("\n").some((text) => text.startsWith(TRIGGER_LINE));
  return states ? readFindingThreadFacts(body).trigger : undefined;
}

/** US-001: the trigger line is metadata, not part of the issue text an item carries. */
function withoutTriggerLines(issue: string): string {
  const lines = issue.split("\n");
  const kept = lines.filter((line) => !line.startsWith(TRIGGER_LINE));
  if (kept.length === lines.length) return issue;
  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function mergeEarlier(input: PostReviewInput, items: AgreedItem[]): AgreedItem[] {
  const seen = new Set(items.map(({ key }) => key));
  for (const { thread, key, verdict, confirmed, reason } of effectiveEarlier(input)) {
    if (verdict?.status !== undefined && verdict.status !== "open") continue;
    if (seen.has(key)) continue;
    seen.add(key);
    // `earlierIssue` is the finding text: the visible header and the identity markers are not content.
    const body = earlierIssue(thread);
    const trigger = earlierTrigger(body);
    const facts = { issue: withoutTriggerLines(body), ...(trigger === undefined ? {} : { trigger }) };
    if (confirmed) {
      items.push({
        kind: "finding",
        key,
        ...facts,
        severity: "important",
        ...(reason !== undefined && reason !== "confirmed" ? { suggestion: reason } : {}),
      });
      continue;
    }
    items.push({
      kind: "finding",
      key,
      ...facts,
      severity: readFindingThreadFacts(body).severity,
      file: thread.path,
      line: thread.line,
    });
  }
  return items;
}

async function persistArtifact(input: PostReviewInput): Promise<void> {
  const artifact: BotReviewArtifact = {
    version: 3,
    ...(input.rulings === undefined ? {} : { rulings: input.rulings }),
    ...(input.callerRulings === undefined ? {} : { callerRulings: input.callerRulings }),
    ...(input.scope === undefined ? {} : { scope: input.scope }),
    ...(input.incrementalSince === undefined ? {} : { incrementalSince: input.incrementalSince }),
    checks: input.staticMode ? null : (input.checks ?? null),
    events: withdrawalEvents(input),
    pr: input.ref,
    headSha: input.info.headSha,
    trusted: !input.staticMode,
    intent: input.verdict.intent,
    quality: reviewQuality(input.scope, input.verdict.quality),
    agreed: agreedItems(input),
    ...(input.blockingTriggers === undefined ? {} : { blockingTriggers: input.blockingTriggers }),
  };
  try {
    await _postDeps.writeArtifact(join(input.stateDir, BOT_REVIEW_FILENAME), artifact);
  } catch (cause) {
    throw new NaxError(
      `[bot-post] Cannot persist review for ${input.ref.repo}#${input.ref.number}`,
      "BOT_REVIEW_WRITE_FAILED",
      { stage: "bot-post", ref: input.ref, cause },
    );
  }
}

async function writeFinding(input: PostReviewInput, finding: PrFinding): Promise<boolean> {
  const own = input.own.find(({ key }) => key === findingKey(finding));
  const body = renderFindingComment(finding);
  if (own) {
    await editComment(input.ref, own.comment, body, input.deps, input.cwd);
    if (own.threadId !== undefined && input.resolvedThreadIds?.has(own.threadId)) {
      try {
        await unresolveThread(input.ref, { id: own.threadId }, input.deps, input.cwd);
      } catch (cause) {
        getLogger()?.warn("bot-post", "Could not reopen a re-raised finding thread", {
          key: own.key,
          threadId: own.threadId,
          error: errorMessage(cause),
        });
        return false;
      }
    }
  } else if (finding.file !== undefined && finding.line !== undefined) {
    await postInlineComment(
      input.ref,
      { path: finding.file, line: finding.line, body, headSha: input.info.headSha, diffRefs: input.info.diffRefs },
      input.deps,
      input.cwd,
    );
  }
  return true;
}

interface SummaryOnlyLists {
  readonly blocking: readonly FindingTrigger[];
  readonly minor: WorkflowFindingDraft[];
  readonly residual: PrFinding[];
}

/**
 * US-003: a finding outside the blocking set gets no new inline thread — it is summary-only, as a minor always
 * was. An own thread for its key is still edited, so a re-raised finding leaves no stale thread behind.
 * Returns whether it took the finding.
 */
function collectSummaryOnly(input: PostReviewInput, finding: PrFinding, into: SummaryOnlyLists): boolean {
  if (isBlockingFinding(finding, into.blocking)) return false;
  if (input.own.some((own) => own.key === findingKey(finding))) return false;
  (finding.severity === "minor" ? into.minor : into.residual).push(finding);
  return true;
}

async function postFindings(input: PostReviewInput): Promise<{
  inlineFindings: number;
  offLine: WorkflowFindingDraft[];
  minor: WorkflowFindingDraft[];
  residual: PrFinding[];
}> {
  const seen = new Set<string>();
  const offLine: WorkflowFindingDraft[] = [];
  const minor: WorkflowFindingDraft[] = [];
  const residual: PrFinding[] = [];
  const summaryOnly: SummaryOnlyLists = {
    blocking: input.blockingTriggers ?? DEFAULT_BLOCKING_TRIGGERS,
    minor,
    residual,
  };
  let inlineFindings = 0;
  for (const finding of input.verdict.findings) {
    if (input.settledKeys?.has(findingKey(finding))) continue;
    if (!finding.file || finding.line === undefined) {
      offLine.push(finding);
      continue;
    }
    const key = findingKey(finding);
    if (seen.has(key)) continue;
    seen.add(key);
    if (collectSummaryOnly(input, finding, summaryOnly)) continue;
    try {
      if (await writeFinding(input, finding)) inlineFindings++;
      else offLine.push(finding);
    } catch (cause) {
      // A failed edit is not a failed new-line post; do not hide it or duplicate the comment.
      if (input.own.some((own) => own.key === key)) throw cause;
      getLogger()?.warn("bot-post", "Inline finding moved off-line", { key, error: errorMessage(cause) });
      offLine.push(finding);
    }
  }
  return { inlineFindings, offLine, minor, residual };
}

async function postThreads(input: PostReviewInput): Promise<{ threadsAnswered: number; failed: number }> {
  let threadsAnswered = 0;
  let failed = 0;
  for (const verdict of input.verdict.threads) {
    const thread = input.threads.find(({ id }) => id === verdict.id);
    if (!thread) continue; // Never invent a forge target for a stale verdict.
    const key = threadKey(thread.id);
    const own = input.own.find((comment) => comment.key === key && comment.threadId === thread.id);
    try {
      const body = renderThreadReply(verdict, {
        notQueued: notQueued(input, verdict.decision, thread.comments[0]),
      });
      if (own) await editComment(input.ref, own.comment, body, input.deps, input.cwd);
      else await replyToThread(input.ref, thread, body, input.deps, input.cwd);
      threadsAnswered++;
    } catch (cause) {
      failed++;
      getLogger()?.warn("bot-post", own ? "Thread edit failed" : "Thread reply failed", {
        threadId: thread.id,
        error: errorMessage(cause),
      });
    }
  }
  return { threadsAnswered, failed };
}

async function postSummary(
  input: PostReviewInput,
  findings: Awaited<ReturnType<typeof postFindings>>,
  threads: Awaited<ReturnType<typeof postThreads>>,
): Promise<void> {
  const body = renderReviewSummary({
    headSha: input.info.headSha,
    ...(input.itemStatus === undefined ? {} : { itemStatus: input.itemStatus }),
    ...(input.scope === undefined ? {} : { scope: input.scope }),
    ...(input.incrementalSince === undefined ? {} : { incrementalSince: input.incrementalSince }),
    intent: input.verdict.intent,
    quality: reviewQuality(input.scope, input.verdict.quality),
    earlier: earlierCounts(input),
    checks: input.staticMode ? null : input.checks,
    preRunFailed: input.preRunFailed,
    ...(input.buildFailed === undefined ? {} : { buildFailed: input.buildFailed }),
    ...(input.ci === undefined ? {} : { ci: input.ci }),
    ...findings,
    ...threads,
    ...(input.blockingTriggers === undefined ? {} : { blockingTriggers: input.blockingTriggers }),
    ...(input.blockingSource === undefined ? {} : { blockingSource: input.blockingSource }),
    ...(input.ignoredScopeRulings === undefined ? {} : { ignoredScopeRulings: input.ignoredScopeRulings }),
    commentVerdicts: input.verdict.comments.map((verdict) => {
      const comment = input.comments.find(({ id }) => id === verdict.id);
      return { verdict, author: comment?.author ?? "unknown", notQueued: notQueued(input, verdict.decision, comment) };
    }),
    unreadFiles: input.unreadFiles,
    cannotVerify: input.verdict.cannotVerify,
    sensitive: input.sensitive,
    staticMode: input.staticMode,
  });
  const own = input.own.find(({ key, threadId }) => key === "summary" && threadId === undefined);
  if (own) await editComment(input.ref, own.comment, body, input.deps, input.cwd);
  else await postPrComment(input.ref, body, input.deps, input.cwd);
}

/**
 * Only a real code review of a workflow PR has coverage to record: a static (untrusted) review reads
 * nothing by design, and a conversation-only review owes no file a look.
 */
function recordsCoverage(input: PostReviewInput): boolean {
  if (input.staticMode || input.scope === "conversation-only") return false;
  return hasNaxWorkflowMarker(input.info.body);
}

/**
 * The record a later readiness check reads back (US-013/US-014): the head this review looked at and the
 * required files it did not read. The summary lists the same files, so the two can never disagree.
 *
 * Best-effort: the record is a claim *about* the review. A forge that refuses the write must not turn a
 * completed review into a failed one, so the failure is logged and the outcome left alone.
 */
async function postCoverageRecord(input: PostReviewInput): Promise<void> {
  if (!recordsCoverage(input)) return;
  try {
    const body = withNaxBotMarker(
      renderCoverageRecord({ headSha: input.info.headSha, uncovered: input.unreadFiles ?? [] }),
      COVERAGE_RECORD_KEY,
    );
    const own = input.own.find(({ key }) => key === COVERAGE_RECORD_KEY);
    if (own) await editComment(input.ref, own.comment, body, input.deps, input.cwd);
    else await postPrComment(input.ref, body, input.deps, input.cwd);
  } catch (cause) {
    getLogger()?.warn("bot-post", "Could not write the review coverage record", {
      pr: input.ref.number,
      error: errorMessage(cause),
    });
  }
}

/** Save complete fix inputs before mutation, then publish findings and the final summary. */
export async function postPrReview(input: PostReviewInput): Promise<PostReviewOutcome> {
  await persistArtifact(input);
  const findings = await postFindings(input);
  const threads = await postThreads(input);
  const earlier = await postEarlier(input);
  const failed = threads.failed + earlier.failed;
  await postSummary(input, findings, { ...threads, failed });
  await postCoverageRecord(input);
  return {
    inlineFindings: findings.inlineFindings,
    ...threads,
    earlierAnswered: earlier.earlierAnswered,
    failed,
    commentsAnswered: input.verdict.comments.length,
    offLine: findings.offLine.length,
  };
}
