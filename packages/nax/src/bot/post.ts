import { join } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { NaxError } from "@/errors";
import type { ForgeDeps, OwnComment, PrComment, PrInfo, PrRef, PrThread } from "@/forge";
import { editComment, postInlineComment, postPrComment, replyToThread, unresolveThread } from "@/forge";
import { getLogger } from "@/logger";
import type { PrFinding, PrReviewVerdict, PrTriageDecision } from "@/operations/bot-types";
import type { WorkflowFindingDraft, WorkflowSeverity } from "@/operations/workflow-types";
import type { EffectiveBlockingTriggers, FindingOrigin, FindingTrigger } from "@/workflow/blocking-findings";
import { DEFAULT_BLOCKING_TRIGGERS, isBlockingFinding, readFindingThreadFacts } from "@/workflow/blocking-findings";
import type { CiWaitResult } from "../workflow/ci-wait";
import type { CallerRulingsReport } from "./caller-rulings";
import { type CarriedFinding, carriedOpen } from "./carried-findings";
import type { CarriedEntry } from "./carried-record";
import type { BotChecks } from "./checks";
import { postCoverageRecord, recordsCodeReview } from "./coverage-record";
import { settleFindingOrigins } from "./finding-origin";
import { postCarriedRecord } from "./post-carried";
import { earlierCounts, earlierIssue, firstCarriedEarlier, postEarlier, withdrawalEvents } from "./post-earlier";
import type { BotPushEntry, FindingLineage } from "./push-ledger";
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
        /** US-001/US-003: where its lines came from; absent reads `pr`, as does a claim nothing backed. */
        readonly origin?: FindingOrigin;
        readonly originEvidence?: string;
        readonly raisedBy?: CarriedEntry["raisedBy"];
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

/**
 * B1: a finding an earlier review of the already-reviewed head recorded but could not anchor — the
 * reviewer gave it no line, or the inline write failed — so it has no thread for `mergeEarlier` to carry.
 */
export type { CarriedFinding } from "./carried-findings";

export interface BotReviewArtifact {
  readonly version: 1 | 2 | 3;
  readonly rulings?: PostReviewInput["rulings"];
  /** What a `--rulings` file did; absent when the flag was not given. */
  readonly callerRulings?: CallerRulingsReport;
  /** What the review actually covered (nax#2667); optional to every earlier reader. */
  readonly scope?: BotReviewScope;
  /** US-003: the reviewed head this review's patch was rebased from. */
  readonly rebasedFrom?: string;
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
  /** US-005: recorded bot pushes the reviewed head can no longer reach, so their lineage is lost. */
  readonly unreachablePushes?: number;
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
  /** US-003: the reviewed head a rebased review's patch came from. */
  readonly rebasedFrom?: string;
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
  /**
   * US-005: the bot's whole recorded push history for this PR. The review graph's `post` node asks it which
   * push owns each finding's line; nothing here posts or renders from it.
   */
  readonly botPushes?: readonly BotPushEntry[];
  /** US-005: the checkout `git blame` runs in — the reviewed head, not the caller's own tree. */
  readonly worktree?: string;
  /** US-005: what that history says about each finding's key; absent when no push was ever recorded. */
  readonly lineage?: {
    readonly lineage: ReadonlyMap<string, FindingLineage>;
    readonly unknown: ReadonlySet<string>;
    readonly unreachable: number;
  };
  /**
   * B1: the findings an earlier review of the already-reviewed head recorded, read back from that
   * review's artifact. Its own review covered only what changed since, so its verdict says nothing about
   * them; a blocking one is carried into `agreed` and the summary, or readiness at this head would
   * release a finding nothing has fixed.
   */
  readonly carriedFindings?: readonly CarriedFinding[];
  /**
   * In-range pushes that may clear a carry if their item cites the review that raised it.
   */
  readonly carriedFixPushes?: readonly BotPushEntry[];
  readonly stateDir: string;
  readonly deps: ForgeDeps;
  readonly cwd: string;
}
export interface PostReviewCounts {
  readonly earlierAnswered: number;
  readonly inlineFindings: number;
  readonly threadsAnswered: number;
  readonly commentsAnswered: number;
  readonly offLine: number;
  readonly failed: number;
}
export interface PostReviewOutcome extends PostReviewCounts {
  /**
   * B2: the coverage record for this head did not land, so the PR may still name files an earlier review
   * of the same head did not read. Dropped from the posted result, but the reviewed head must not advance
   * on it: the next default review would be conversation-only and could never replace the record.
   */
  readonly coverageRecordFailed?: true;
  /**
   * B1: the carried-findings record did not land whole, so a finding this review could not re-report may
   * have no durable record. The reviewed head must not advance on it: the next review would skip the only
   * changes that could re-raise it.
   */
  readonly carriedRecordFailed?: true;
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

/**
 * US-005: the lineage the review read for this key — or the fact that the read itself failed, which is
 * not the same as "no push wrote these lines" and must not be reported as one.
 */
function lineageFacts(
  input: PostReviewInput,
  key: string,
): { readonly lineage?: FindingLineage; readonly lineageUnknown?: true } {
  const lineage = input.lineage?.lineage.get(key);
  if (lineage !== undefined) return { lineage };
  return input.lineage?.unknown.has(key) === true ? { lineageUnknown: true } : {};
}

function agreedItems(input: PostReviewInput, reviewId?: string): AgreedItem[] {
  const items: AgreedItem[] = input.verdict.findings
    .filter((finding) => !input.settledKeys?.has(findingKey(finding)))
    .map(({ severity, issue, file, line, suggestion, decision, trigger, triggerEvidence, origin, originEvidence }) => {
      const key = findingKey({ file, issue });
      return {
        key,
        kind: "finding",
        severity,
        issue,
        file,
        line,
        suggestion,
        ...(decision === undefined ? {} : { decision }),
        ...(trigger === undefined ? {} : { trigger }),
        ...(triggerEvidence === undefined ? {} : { triggerEvidence }),
        // US-003: the origin the settlement left, so a later fix or readiness pass reads the same claim.
        ...(origin === undefined ? {} : { origin }),
        ...(originEvidence === undefined ? {} : { originEvidence }),
        ...(reviewId === undefined ? {} : { raisedBy: reviewId }),
        ...lineageFacts(input, key),
      };
    });
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
  items.push(...carriedOpen(input));
  return mergeEarlier(input, items);
}

const TRIGGER_LINE = "Trigger:";
/** US-004: the origin fact an earlier thread states, and the one its merged issue must not keep. */
const ORIGIN_LINE = "Origin:";
/** US-005: the same shape the fix prompt and the inline body use, so one reader strips either. */
const LINEAGE_LINE = "Lineage:";

/** Whether an earlier body states the fact line at all; a body that is silent claims nothing. */
function statesLine(body: string, prefix: string): boolean {
  return body.split("\n").some((text) => text.startsWith(prefix));
}

/**
 * US-002/US-004: the trigger class and origin an earlier finding's first comment states, each kept only
 * when the body states it — the values themselves are read by the shared `readFindingThreadFacts`. An old
 * thread written before the vocabulary existed keeps an absent trigger, so it still blocks as it did, and
 * carries no origin, which reads `pr` and blocks too.
 */
function earlierFacts(body: string): { trigger?: FindingTrigger; origin?: FindingOrigin } {
  const { trigger, origin } = readFindingThreadFacts(body);
  return {
    ...(statesLine(body, TRIGGER_LINE) ? { trigger } : {}),
    ...(statesLine(body, ORIGIN_LINE) ? { origin } : {}),
  };
}

/**
 * US-001/US-004/US-005: the fact lines a rendered body carries are metadata, not part of the issue text an
 * item keeps — `Trigger:`, `Origin:` and `Lineage:` say where a finding came from, not what it says.
 */
function withoutFactLines(issue: string): string {
  const metadata = [TRIGGER_LINE, ORIGIN_LINE, LINEAGE_LINE];
  const lines = issue.split("\n");
  const kept = lines.filter((line) => !metadata.some((prefix) => line.startsWith(prefix)));
  if (kept.length === lines.length) return issue;
  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function mergeEarlier(input: PostReviewInput, items: AgreedItem[]): AgreedItem[] {
  const seen = new Set(items.map(({ key }) => key));
  // B3: the same first-wins selection the lineage targets use, so the anchor blamed is the anchor kept.
  for (const { thread, key, confirmed, reason } of firstCarriedEarlier(input)) {
    if (seen.has(key)) continue;
    seen.add(key);
    // `earlierIssue` is the finding text: the visible header and the identity markers are not content.
    const body = earlierIssue(thread);
    // A finding carried over from an earlier round keeps the facts its own thread states (US-002, US-004)
    // and the lineage its own key was read for (US-005).
    const facts = {
      issue: withoutFactLines(body),
      ...earlierFacts(body),
      ...lineageFacts(input, key),
    };
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

async function persistArtifact(input: PostReviewInput, reviewId: string | undefined): Promise<void> {
  const artifact: BotReviewArtifact = {
    version: 3,
    ...(input.rulings === undefined ? {} : { rulings: input.rulings }),
    ...(input.callerRulings === undefined ? {} : { callerRulings: input.callerRulings }),
    ...(input.scope === undefined ? {} : { scope: input.scope }),
    ...(input.rebasedFrom === undefined ? {} : { rebasedFrom: input.rebasedFrom }),
    ...(input.incrementalSince === undefined ? {} : { incrementalSince: input.incrementalSince }),
    checks: input.staticMode ? null : (input.checks ?? null),
    events: withdrawalEvents(input),
    pr: input.ref,
    headSha: input.info.headSha,
    trusted: !input.staticMode,
    intent: input.verdict.intent,
    quality: reviewQuality(input.scope, input.verdict.quality),
    agreed: agreedItems(input, reviewId),
    ...(input.blockingTriggers === undefined ? {} : { blockingTriggers: input.blockingTriggers }),
    ...(input.lineage === undefined || input.lineage.unreachable === 0
      ? {}
      : { unreachablePushes: input.lineage.unreachable }),
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
  const key = findingKey(finding);
  const own = input.own.find(({ key: ownKey }) => ownKey === key);
  const lineage = input.lineage?.lineage.get(key);
  // US-005: the inline body carries the same lineage fact the artifact records.
  const body = renderFindingComment({ ...finding, ...(lineage === undefined ? {} : { lineage }) });
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
  reopenFailed: number;
  offLine: PrFinding[];
  minor: WorkflowFindingDraft[];
  residual: PrFinding[];
}> {
  const seen = new Set<string>();
  const offLine: PrFinding[] = [];
  const minor: WorkflowFindingDraft[] = [];
  const residual: PrFinding[] = [];
  const summaryOnly: SummaryOnlyLists = {
    blocking: input.blockingTriggers ?? DEFAULT_BLOCKING_TRIGGERS,
    minor,
    residual,
  };
  let inlineFindings = 0;
  let reopenFailed = 0;
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
      else {
        reopenFailed++;
        offLine.push(finding);
      }
    } catch (cause) {
      // A failed edit is not a failed new-line post; do not hide it or duplicate the comment.
      if (input.own.some((own) => own.key === key)) throw cause;
      getLogger()?.warn("bot-post", "Inline finding moved off-line", { key, error: errorMessage(cause) });
      offLine.push(finding);
    }
  }
  return { inlineFindings, reopenFailed, offLine, minor, residual };
}

/**
 * US-008: the agreed findings that hold readiness under the set this review posted with. `agreedItems`
 * is the same list the artifact records, so the count the summary states and the items a later fix or
 * readiness pass acts on cannot disagree.
 */
function blockingFindingCount(input: PostReviewInput): number {
  const blocking = input.blockingTriggers ?? DEFAULT_BLOCKING_TRIGGERS;
  return agreedItems(input).filter((item) => item.kind === "finding" && isBlockingFinding(item, blocking)).length;
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
    // US-008: the index counts items only, and a finding is a thread (#2981), so the summary counts
    // the agreed findings that hold readiness beside it.
    blockingCount: blockingFindingCount(input),
    ...(input.scope === undefined ? {} : { scope: input.scope }),
    ...(input.rebasedFrom === undefined ? {} : { rebasedFrom: input.rebasedFrom }),
    ...(input.incrementalSince === undefined ? {} : { incrementalSince: input.incrementalSince }),
    intent: input.verdict.intent,
    quality: reviewQuality(input.scope, input.verdict.quality),
    earlier: earlierCounts(input),
    checks: input.staticMode ? null : input.checks,
    preRunFailed: input.preRunFailed,
    ...(input.buildFailed === undefined ? {} : { buildFailed: input.buildFailed }),
    ...(input.ci === undefined ? {} : { ci: input.ci }),
    ...findings,
    carried: carriedOpen(input),
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

/** Save complete fix inputs before mutation, then publish findings and the final summary. */
export async function postPrReview(received: PostReviewInput): Promise<PostReviewOutcome> {
  // US-003: settlement comes first, so even the review id and the artifact record the settled origins. The
  // caller's own input is left untouched: every later call in this function reads this copy.
  const input: PostReviewInput = {
    ...received,
    verdict: settleFindingOrigins(received.verdict, {
      lineage: received.lineage,
      // A top-level own comment (summary, carried record, signals) has no thread, so it is not one of these.
      ownThreadKeys: new Set(received.own.flatMap(({ key, threadId }) => (threadId === undefined ? [] : [key]))),
    }),
  };
  const reviewId = crypto.randomUUID();
  await persistArtifact(input, recordsCodeReview(input) ? reviewId : undefined);
  const findings = await postFindings(input);
  const threads = await postThreads(input);
  const earlier = await postEarlier(input);
  const failed = threads.failed + earlier.failed + findings.reopenFailed;
  await postSummary(input, findings, { ...threads, failed });
  const coverageRecorded = await postCoverageRecord(input);
  // A full rerun can target an already-indexed head: do not replace its carry with an incomplete review.
  const complete = failed === 0 && coverageRecorded && (input.unreadFiles?.length ?? 0) === 0;
  const carriedRecorded = await postCarriedRecord(input, findings.offLine, { id: reviewId, complete });
  return {
    inlineFindings: findings.inlineFindings,
    ...threads,
    earlierAnswered: earlier.earlierAnswered,
    failed,
    commentsAnswered: input.verdict.comments.length,
    offLine: findings.offLine.length,
    ...(coverageRecorded ? {} : { coverageRecordFailed: true as const }),
    ...(carriedRecorded ? {} : { carriedRecordFailed: true as const }),
  };
}
