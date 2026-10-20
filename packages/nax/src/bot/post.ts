import { join } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { NaxError } from "@/errors";
import type { ForgeDeps, OwnComment, PrComment, PrInfo, PrRef, PrThread } from "@/forge";
import {
  editComment,
  NAX_BOT_HEADER,
  ownComments,
  parseNaxBotMarker,
  postInlineComment,
  postPrComment,
  replyToThread,
  resolveThread,
} from "@/forge";
import { getLogger } from "@/logger";
import type { PrReviewVerdict } from "@/operations/bot-types";
import type { WorkflowFindingDraft, WorkflowSeverity } from "@/operations/workflow-types";
import type { BotChecks } from "./checks";
import { commentKey, earlierKey, findingKey, threadKey } from "./render";
import { renderEarlierReply, renderFindingComment, renderReviewSummary, renderThreadReply } from "./render-comments";

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
  readonly version: 1 | 2;
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
  readonly preRunFailed?: string;
  readonly earlier?: readonly PrThread[];
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

export const _postDeps = {
  writeArtifact: (path: string, artifact: BotReviewArtifact): Promise<number> =>
    Bun.write(path, `${JSON.stringify(artifact, null, 2)}\n`),
};

function agreedItems(input: PostReviewInput): AgreedItem[] {
  const items: AgreedItem[] = input.verdict.findings.map(({ severity, issue, file, line, suggestion, decision }) => ({
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
    if (!thread) continue; // A partial or stale triage cannot supply a forge target.
    items.push({
      key: threadKey(thread.id),
      kind: "thread",
      issue: thread.comments[0]?.body ?? "",
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
    if (!comment) continue;
    items.push({ key: commentKey(comment.id), kind: "comment", issue: comment.body, reason: verdict.reason });
  }
  return mergeEarlier(input, items);
}

function mergeEarlier(input: PostReviewInput, items: AgreedItem[]): AgreedItem[] {
  const seen = new Set(items.map(({ key }) => key));
  for (const { thread, key, verdict } of effectiveEarlier(input)) {
    if (verdict?.status !== undefined && verdict.status !== "open") continue;
    if (seen.has(key)) continue;
    seen.add(key);
    const issue = earlierIssue(thread);
    const severity = issue.startsWith("**Critical**")
      ? "critical"
      : issue.startsWith("**Minor**")
        ? "minor"
        : "important";
    items.push({ kind: "finding", key, issue, severity, file: thread.path, line: thread.line });
  }
  return items;
}

/** Keep absent verdicts and re-raised findings open, including threads beyond the prompt cap. */
function effectiveEarlier(input: PostReviewInput) {
  const raised = new Set(input.verdict.findings.map(findingKey));
  return (input.earlier ?? []).flatMap((thread) => {
    const first = thread.comments[0];
    const key = parseNaxBotMarker(first?.body ?? "")?.key;
    // Selection supplies own finding threads; defend against a foreign opener when login is available.
    if (!key?.startsWith("f-") || (input.login !== undefined && first?.author !== input.login)) return [];
    const verdict = raised.has(key) ? undefined : input.verdict.earlier?.find(({ id }) => id === thread.id);
    return [{ thread, key, verdict }];
  });
}

function earlierIssue(thread: PrThread): string {
  return (thread.comments[0]?.body ?? "")
    .split("\n")
    .filter((line) => line.trim() !== NAX_BOT_HEADER)
    .join("\n")
    .replace(/<!-- nax-bot:v1 key=[A-Za-z0-9._:-]{1,128} -->/g, "")
    .trim();
}

async function postEarlier(input: PostReviewInput): Promise<{ earlierAnswered: number; failed: number }> {
  let failed = 0;
  for (const { thread, verdict } of effectiveEarlier(input)) {
    if (!verdict || verdict.status === "open") continue;
    const own = [
      ...input.own,
      ...(input.login === undefined ? [] : ownComments(thread.comments, input.login, thread.id)),
    ].find((comment) => comment.key === earlierKey(thread.id) && comment.threadId === thread.id);
    let action = "reply";
    try {
      const body = renderEarlierReply(verdict, thread.id);
      if (own) await editComment(input.ref, own.comment, body, input.deps, input.cwd);
      else await replyToThread(input.ref, thread, body, input.deps, input.cwd);
      action = "resolve";
      await resolveThread(input.ref, thread, input.deps, input.cwd);
    } catch (cause) {
      failed++;
      getLogger()?.warn("bot-post", `Earlier finding ${action} failed`, {
        threadId: thread.id,
        error: errorMessage(cause),
      });
    }
  }
  return { earlierAnswered: input.earlier?.length ?? 0, failed };
}

function withdrawalEvents(input: PostReviewInput): BotReviewEvent[] {
  if (input.login === undefined) return [];
  return effectiveEarlier(input).flatMap(({ thread, key, verdict }) => {
    if (verdict?.status !== "withdrawn") return [];
    const disagreedBy = [
      ...new Set(thread.comments.map(({ author }) => author).filter((author) => author !== input.login)),
    ];
    if (disagreedBy.length === 0) return [];
    return [
      {
        type: "finding-withdrawn" as const,
        key,
        threadId: thread.id,
        file: thread.path,
        line: thread.line,
        finding: earlierIssue(thread),
        reason: verdict.reason,
        disagreedBy,
      },
    ];
  });
}

async function persistArtifact(input: PostReviewInput): Promise<void> {
  const artifact: BotReviewArtifact = {
    version: 2,
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
    await _postDeps.writeArtifact(join(input.stateDir, "bot-review.json"), artifact);
  } catch (cause) {
    throw new NaxError(
      `[bot-post] Cannot persist review for ${input.ref.repo}#${input.ref.number}`,
      "BOT_REVIEW_WRITE_FAILED",
      { stage: "bot-post", ref: input.ref, cause },
    );
  }
}

async function writeFinding(input: PostReviewInput, finding: WorkflowFindingDraft): Promise<void> {
  const own = input.own.find(({ key }) => key === findingKey(finding));
  const body = renderFindingComment(finding);
  if (own) {
    await editComment(input.ref, own.comment, body, input.deps, input.cwd);
  } else if (finding.file !== undefined && finding.line !== undefined) {
    await postInlineComment(
      input.ref,
      { path: finding.file, line: finding.line, body, headSha: input.info.headSha, diffRefs: input.info.diffRefs },
      input.deps,
      input.cwd,
    );
  }
}

async function postFindings(
  input: PostReviewInput,
): Promise<{ inlineFindings: number; offLine: WorkflowFindingDraft[]; minor: WorkflowFindingDraft[] }> {
  const seen = new Set<string>();
  const offLine: WorkflowFindingDraft[] = [];
  const minor: WorkflowFindingDraft[] = [];
  let inlineFindings = 0;
  for (const finding of input.verdict.findings) {
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
      await writeFinding(input, finding);
      inlineFindings++;
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
      const body = renderThreadReply(verdict);
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

function earlierCounts(input: PostReviewInput): { open: number; fixed: number; withdrawn: number } {
  const counts = { open: 0, fixed: 0, withdrawn: 0 };
  for (const { verdict } of effectiveEarlier(input)) counts[verdict?.status ?? "open"]++;
  return counts;
}

async function postSummary(
  input: PostReviewInput,
  findings: Awaited<ReturnType<typeof postFindings>>,
  threads: Awaited<ReturnType<typeof postThreads>>,
): Promise<void> {
  const body = renderReviewSummary({
    headSha: input.info.headSha,
    intent: input.verdict.intent,
    quality: input.verdict.quality,
    earlier: earlierCounts(input),
    checks: input.staticMode ? null : input.checks,
    preRunFailed: input.preRunFailed,
    ...findings,
    ...threads,
    commentVerdicts: input.verdict.comments.map((verdict) => ({
      verdict,
      author: input.comments.find(({ id }) => id === verdict.id)?.author ?? "unknown",
    })),
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
