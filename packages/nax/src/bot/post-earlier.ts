import { errorMessage } from "@nathapp/nax-agent/internal";
import {
  editComment,
  NAX_BOT_HEADER,
  ownComments,
  type PrThread,
  parseNaxBotMarker,
  replyToThread,
  resolveThread,
  stripNaxBotMarkers,
  withNaxBotMarker,
} from "@/forge";
import { getLogger } from "@/logger";
import { parseItemOpener, renderRulingEcho } from "../workflow/item-threads";
import type { BotReviewEvent, PostReviewInput } from "./post";
import { earlierKey, findingKey } from "./render";
import { renderEarlierReply } from "./render-comments";

function combinedEarlier(input: PostReviewInput): PrThread[] {
  return [
    ...new Map(
      [
        ...(input.earlier ?? []),
        ...(input.itemEarlier ?? []),
        ...(input.itemConfirmed ?? []).map(({ thread }) => thread),
      ].map((thread) => [thread.id, thread]),
    ).values(),
  ];
}

interface EarlierEntry {
  readonly thread: PrThread;
  readonly key: string;
  readonly blocked?: true;
  readonly confirmed?: true;
  readonly reason?: string;
  readonly verdict?: NonNullable<PostReviewInput["verdict"]["earlier"]>[number];
}

/** Keep absent verdicts and re-raised findings open, including threads beyond the prompt cap. */
export function effectiveEarlier(input: PostReviewInput): EarlierEntry[] {
  const raised = new Set(input.verdict.findings.map(findingKey));
  return combinedEarlier(input).flatMap<EarlierEntry>((thread) => {
    const first = thread.comments[0];
    const key = parseNaxBotMarker(first?.body ?? "")?.key;
    // Selection supplies own finding threads; defend against a foreign opener when login is available.
    if (
      (!key?.startsWith("f-") && !key?.startsWith("w-")) ||
      (input.login !== undefined && first?.author !== input.login)
    )
      return [];
    const confirmed = input.itemConfirmed?.find((item) => item.thread.id === thread.id);
    if (confirmed) return [{ thread, key, confirmed: true, reason: confirmed.reason }];
    const verdict = raised.has(key) ? undefined : input.verdict.earlier?.find(({ id }) => id === thread.id);
    if (key.startsWith("w-") && verdict?.status === "fixed" && input.itemFixedBlocked === true)
      return [{ thread, key, verdict: { ...verdict, status: "open" }, blocked: true }];
    return [{ thread, key, verdict }];
  });
}

export function earlierIssue(thread: PrThread): string {
  const content = stripNaxBotMarkers(thread.comments[0]?.body ?? "")
    .split("\n")
    .filter((line) => line.trim() !== NAX_BOT_HEADER)
    .join("\n")
    .trim();
  return parseNaxBotMarker(thread.comments[0]?.body ?? "")?.key.startsWith("w-")
    ? (content.split(/\r?\n/)[0] ?? "")
    : content;
}

function warnSkippedEarlier(input: PostReviewInput, handledIds: readonly string[]): void {
  for (const thread of combinedEarlier(input)) {
    if (handledIds.includes(thread.id)) continue;
    const marker = parseNaxBotMarker(thread.comments[0]?.body ?? "");
    const reason = !marker
      ? "missing-marker"
      : !marker.key.startsWith("f-") && !marker.key.startsWith("w-")
        ? "not-finding"
        : "foreign-author";
    getLogger()?.warn("bot-post", "Skipping invalid earlier finding thread", {
      threadId: thread.id,
      login: input.login,
      reason,
    });
  }
}

function warnBlockedEarlier({ thread, key, blocked }: EarlierEntry): void {
  if (!blocked) return;
  getLogger()?.warn("bot-post", "Kept item open: the review read text from someone without write access", {
    threadId: thread.id,
    key,
  });
}

function fixedItemBody(input: { key: string; thread: PrThread; reason: string; sha: string }): string {
  const { key, thread, reason, sha } = input;
  return withNaxBotMarker(
    renderRulingEcho({
      itemKey: key,
      itemId: parseItemOpener(thread.comments[0]?.body ?? "")?.id ?? key,
      disposition: "fixed",
      sha,
      by: null,
      reason,
    }),
    `wr-fixed-${key}`,
  );
}

export async function postEarlier(input: PostReviewInput): Promise<{ earlierAnswered: number; failed: number }> {
  let failed = 0;
  const earlier = effectiveEarlier(input);
  warnSkippedEarlier(
    input,
    earlier.map(({ thread }) => thread.id),
  );
  for (const entry of earlier) {
    warnBlockedEarlier(entry);
    const { thread, key, verdict } = entry;
    if (!verdict || verdict.status === "open") continue;
    const itemFixed = key.startsWith("w-") && verdict.status === "fixed";
    const replyKey = itemFixed ? `wr-fixed-${key}` : earlierKey(thread.id);
    const own = [
      ...input.own,
      ...(input.login === undefined ? [] : ownComments(thread.comments, input.login, thread.id)),
    ].find((comment) => comment.key === replyKey && comment.threadId === thread.id);
    let action = "reply";
    try {
      const body = itemFixed
        ? fixedItemBody({ key, thread, reason: verdict.reason, sha: input.info.headSha })
        : renderEarlierReply(verdict, thread.id);
      if (own && (!itemFixed || thread.comments.at(-1)?.id === own.comment.id))
        await editComment(input.ref, own.comment, body, input.deps, input.cwd);
      else await replyToThread(input.ref, thread, body, input.deps, input.cwd);
      if (key.startsWith("w-") && verdict.status === "withdrawn") continue;
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
  return { earlierAnswered: earlier.length, failed };
}

export function withdrawalEvents(input: PostReviewInput): BotReviewEvent[] {
  if (input.login === undefined) return [];
  return effectiveEarlier(input).flatMap(({ thread, key, verdict }) => {
    if (!key.startsWith("f-") || verdict?.status !== "withdrawn") return [];
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

export function earlierCounts(input: PostReviewInput): { open: number; fixed: number; withdrawn: number } {
  const counts = { open: 0, fixed: 0, withdrawn: 0 };
  for (const { verdict } of effectiveEarlier(input)) counts[verdict?.status ?? "open"]++;
  return counts;
}
