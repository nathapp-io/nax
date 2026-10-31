import { join } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { NaxError } from "@/errors";
import type { ForgeDeps, OwnComment, PrComment, PrInfo, PrRef, PrThread } from "@/forge";
import { editComment, postInlineComment, postPrComment, replyToThread, unresolveThread } from "@/forge";
import { getLogger } from "@/logger";
import type { PrReviewVerdict, PrTriageDecision } from "@/operations/bot-types";
import type { WorkflowFindingDraft, WorkflowSeverity } from "@/operations/workflow-types";
import type { CiWaitResult } from "../workflow/ci-wait";
import type { BotChecks } from "./checks";
import { earlierCounts, earlierIssue, effectiveEarlier, postEarlier, withdrawalEvents } from "./post-earlier";
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
  readonly quality: PrReviewVerdict["quality"];
  readonly agreed: readonly AgreedItem[];
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
    .map(({ severity, issue, file, line, suggestion, decision }) => ({
      key: findingKey({ file, issue }),
      kind: "finding",
      severity,
      issue,
      file,
      line,
      suggestion,
      ...(decision === undefined ? {} : { decision }),
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

function mergeEarlier(input: PostReviewInput, items: AgreedItem[]): AgreedItem[] {
  const seen = new Set(items.map(({ key }) => key));
  for (const { thread, key, verdict, confirmed, reason } of effectiveEarlier(input)) {
    if (verdict?.status !== undefined && verdict.status !== "open") continue;
    if (seen.has(key)) continue;
    seen.add(key);
    const issue = earlierIssue(thread);
    if (confirmed) {
      items.push({
        kind: "finding",
        key,
        issue,
        severity: "important",
        ...(reason !== undefined && reason !== "confirmed" ? { suggestion: reason } : {}),
      });
      continue;
    }
    const severity = issue.startsWith("**Critical**")
      ? "critical"
      : issue.startsWith("**Minor**")
        ? "minor"
        : "important";
    items.push({ kind: "finding", key, issue, severity, file: thread.path, line: thread.line });
  }
  return items;
}

async function persistArtifact(input: PostReviewInput): Promise<void> {
  const artifact: BotReviewArtifact = {
    version: 3,
    ...(input.rulings === undefined ? {} : { rulings: input.rulings }),
    ...(input.scope === undefined ? {} : { scope: input.scope }),
    ...(input.incrementalSince === undefined ? {} : { incrementalSince: input.incrementalSince }),
    checks: input.staticMode ? null : (input.checks ?? null),
    events: withdrawalEvents(input),
    pr: input.ref,
    headSha: input.info.headSha,
    trusted: !input.staticMode,
    intent: input.verdict.intent,
    quality: input.verdict.quality,
    agreed: agreedItems(input),
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

async function writeFinding(input: PostReviewInput, finding: WorkflowFindingDraft): Promise<boolean> {
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

async function postFindings(
  input: PostReviewInput,
): Promise<{ inlineFindings: number; offLine: WorkflowFindingDraft[]; minor: WorkflowFindingDraft[] }> {
  const seen = new Set<string>();
  const offLine: WorkflowFindingDraft[] = [];
  const minor: WorkflowFindingDraft[] = [];
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
    if (finding.severity === "minor" && !input.own.some((own) => own.key === key)) {
      minor.push(finding);
      continue;
    }
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
  return { inlineFindings, offLine, minor };
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
    quality: input.verdict.quality,
    earlier: earlierCounts(input),
    checks: input.staticMode ? null : input.checks,
    preRunFailed: input.preRunFailed,
    ...(input.buildFailed === undefined ? {} : { buildFailed: input.buildFailed }),
    ...(input.ci === undefined ? {} : { ci: input.ci }),
    ...findings,
    ...threads,
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
export async function postPrReview(input: PostReviewInput): Promise<PostReviewOutcome> {
  await persistArtifact(input);
  const findings = await postFindings(input);
  const threads = await postThreads(input);
  const earlier = await postEarlier(input);
  const failed = threads.failed + earlier.failed;
  await postSummary(input, findings, { ...threads, failed });
  return {
    inlineFindings: findings.inlineFindings,
    ...threads,
    earlierAnswered: earlier.earlierAnswered,
    failed,
    commentsAnswered: input.verdict.comments.length,
    offLine: findings.offLine.length,
  };
}
