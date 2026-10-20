import { join } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { NaxError } from "@/errors";
import type { ForgeDeps, OwnComment, PrComment, PrInfo, PrRef, PrThread } from "@/forge";
import { editComment, postInlineComment, postPrComment, replyToThread } from "@/forge";
import { getLogger } from "@/logger";
import type { PrReviewVerdict } from "@/operations/bot-types";
import type { WorkflowFindingDraft, WorkflowSeverity } from "@/operations/workflow-types";
import { commentKey, findingKey, threadKey } from "./render";
import { renderFindingComment, renderReviewSummary, renderThreadReply } from "./render-comments";

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
      AgreedLocation & { readonly kind: "finding"; readonly severity: WorkflowSeverity; readonly suggestion?: string })
  | (AgreedBase &
      AgreedLocation & {
        readonly kind: "thread";
        readonly reason: string;
        readonly threadId: string;
        readonly replyTo: string;
      })
  | (AgreedBase & { readonly kind: "comment"; readonly reason: string });

export interface BotReviewArtifact {
  readonly version: 1;
  readonly pr: PrRef;
  readonly headSha: string;
  /** Diagnostic only; not an authorization decision for fixes. */
  readonly trusted: boolean;
  readonly intent: PrReviewVerdict["intent"];
  readonly quality: PrReviewVerdict["quality"];
  readonly agreed: readonly AgreedItem[];
}
export interface PostReviewInput {
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
  const items: AgreedItem[] = input.verdict.findings.map(({ severity, issue, file, line, suggestion }) => ({
    key: findingKey({ file, issue }),
    kind: "finding",
    severity,
    issue,
    file,
    line,
    suggestion,
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
  return items;
}

async function persistArtifact(input: PostReviewInput): Promise<void> {
  const artifact: BotReviewArtifact = {
    version: 1,
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
): Promise<{ inlineFindings: number; offLine: WorkflowFindingDraft[] }> {
  const seen = new Set<string>();
  const offLine: WorkflowFindingDraft[] = [];
  let inlineFindings = 0;
  for (const finding of input.verdict.findings) {
    if (!finding.file || finding.line === undefined) {
      offLine.push(finding);
      continue;
    }
    const key = findingKey(finding);
    if (seen.has(key)) continue;
    seen.add(key);
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
  return { inlineFindings, offLine };
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

async function postSummary(
  input: PostReviewInput,
  findings: Awaited<ReturnType<typeof postFindings>>,
  threads: Awaited<ReturnType<typeof postThreads>>,
): Promise<void> {
  const body = renderReviewSummary({
    headSha: input.info.headSha,
    intent: input.verdict.intent,
    quality: input.verdict.quality,
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
  await postSummary(input, findings, threads);
  return {
    inlineFindings: findings.inlineFindings,
    ...threads,
    commentsAnswered: input.verdict.comments.length,
    offLine: findings.offLine.length,
  };
}
