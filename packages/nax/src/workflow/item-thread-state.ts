import { ownComments } from "@/forge";
import type { PrComment, PrThread } from "@/forge/pr-types";
import type { ItemIndex, PrRuling } from "./item-threads";
import { parseItemIndex, parseItemOpener, parseRulingEcho } from "./item-threads";

export interface ItemThread {
  readonly key: string;
  readonly itemId: string;
  readonly kind: string;
  readonly thread: PrThread;
  readonly ruling?: PrRuling;
  readonly replies: readonly PrComment[];
}

export interface ReadItemThreads {
  readonly index?: ItemIndex;
  readonly indexComment?: PrComment;
  readonly items: readonly ItemThread[];
}

export interface SettledItems {
  readonly settled: readonly (ItemThread & { readonly ruling: PrRuling })[];
  readonly open: readonly (ItemThread & { readonly kept: readonly PrComment[] })[];
}

function readThread(thread: PrThread, login: string): ItemThread | null {
  const own = ownComments(thread.comments, login);
  const opener = own[0];
  if (!opener || opener.comment !== thread.comments[0] || !opener.key.startsWith("w-")) return null;
  const identity = parseItemOpener(opener.comment.body);
  if (!identity) return null;
  const last = own.at(-1);
  const parsed = last?.key.startsWith("wr-") ? parseRulingEcho(last.key, last.comment.body) : null;
  const ruling = parsed?.itemKey === opener.key && parsed.itemId === identity.id ? parsed : undefined;
  const boundary = last ? thread.comments.indexOf(last.comment) : 0;
  const owned = new Set(own.map(({ comment }) => comment));
  return {
    key: opener.key,
    itemId: identity.id,
    kind: identity.kind,
    thread,
    ...(ruling ? { ruling } : {}),
    replies: thread.comments.slice(boundary + 1).filter((comment) => !owned.has(comment)),
  };
}

/** Keep all owned item threads for publish-time closing; settlement applies index membership. */
export function readItemThreads(
  threads: readonly PrThread[],
  comments: readonly PrComment[],
  login: string,
): ReadItemThreads {
  const indexComment = ownComments(comments, login)
    .filter(({ key }) => key === "w-index")
    .at(-1)?.comment;
  const index = indexComment ? parseItemIndex(indexComment.body) : null;
  const items = threads.flatMap((thread) => {
    const item = readThread(thread, login);
    return item ? [item] : [];
  });
  return { items, ...(indexComment ? { indexComment } : {}), ...(index ? { index } : {}) };
}

async function keepReply(comment: PrComment, canRule: (c: PrComment) => Promise<boolean>): Promise<boolean> {
  try {
    return await canRule(comment);
  } catch {
    // Permission lookup failures deny only this reply; existing echoes remain valid.
    return false;
  }
}

/** Only indexed items participate. Accepted writer replies reopen even an existing ruling. */
export async function settleItemThreads(
  read: ReadItemThreads,
  canRule: (c: PrComment) => Promise<boolean>,
): Promise<SettledItems> {
  const settled: (ItemThread & { readonly ruling: PrRuling })[] = [];
  const open: (ItemThread & { readonly kept: readonly PrComment[] })[] = [];
  const items = [...new Set(read.index?.keys ?? [])].flatMap((key) => read.items.filter((item) => item.key === key));
  const results = await Promise.all(
    items.map(async (item) => {
      const accepted = await Promise.all(item.replies.map((reply) => keepReply(reply, canRule)));
      return { item, kept: item.replies.filter((_, index) => accepted[index]) };
    }),
  );
  for (const { item, kept } of results) {
    if (item.ruling && kept.length === 0) settled.push({ ...item, ruling: item.ruling });
    else open.push({ ...item, kept });
  }
  return { settled, open };
}
