/** Durable publish-time index and obsolete-thread closures. These replies are not rulings. */
import { errorMessage } from "@nathapp/nax-agent/internal";
import type { ForgeDeps, PrRef } from "@/forge";
import { editComment, ownComments, postPrComment, replyToThread, resolveThread, withNaxBotMarker } from "@/forge";
import { getLogger } from "@/logger";
import { type ItemPublishPacer, isDefiniteRejection } from "./item-publish-pacer";
import type { ReadItemThreads } from "./item-thread-state";
import { closedKey, type ItemIndex, renderItemClosed, renderItemIndex } from "./item-threads";
import type { ItemThreadsInput } from "./item-threads-post";

export interface IndexContext {
  /** Reuse an index created by the pre-notice write during this publish. */
  postedIndex?: { id: string; kind: "comment" };
  /** The publish's pacer: the index write is reserved, the closing writes are paced normally. */
  readonly pacer: ItemPublishPacer;
  readonly ref: PrRef;
  readonly read: ReadItemThreads;
  readonly login: string;
  readonly deps: ForgeDeps;
  readonly cwd: string;
  readonly info: { readonly headSha: string };
}

export function reviewedIndex(input: ItemThreadsInput, previous: ItemIndex | undefined): Omit<ItemIndex, "keys"> {
  const rec = input.record;
  if (
    rec.reviewRan !== true ||
    (rec.reviewUnread?.length ?? 0) > 0 ||
    rec.costLimited ||
    rec.reReviewSkipped ||
    (rec.gateRepairRounds ?? 0) > 0
  )
    return {};
  if ((rec.ciRepairRounds ?? 0) > 0)
    return { reviewedHead: previous?.reviewedHead, reviewedBase: previous?.reviewedBase };
  return { reviewedHead: input.head, reviewedBase: rec.seed ?? undefined };
}

/**
 * Why a failed index write failed: `refused` — the forge answered and refused it, so nothing
 * landed; `unconfirmed` — it may have landed, and no answer can be read from it.
 */
export type IndexWriteFailure = "refused" | "unconfirmed";

/** What one index write left on the PR, and — when it failed — whether the forge refused it. */
export interface IndexWriteOutcome {
  readonly written: boolean;
  readonly failure?: IndexWriteFailure;
}

/** One paced forge write, logged as failed rather than thrown: the publish reports counts, never errors. */
async function write(
  itemId: string,
  pacer: ItemPublishPacer,
  action: () => Promise<unknown>,
  options: { readonly reserved?: boolean } = {},
): Promise<IndexWriteOutcome> {
  try {
    await (options.reserved === true ? pacer.writeReserved(action, { itemId }) : pacer.write(action, { itemId }));
    return { written: true };
  } catch (error) {
    getLogger()?.warn("item-threads", "[item-threads] Index or closing write failed", {
      itemId,
      error: errorMessage(error),
    });
    // A refusal is evidence the comment does not exist; anything else may have landed, so it is
    // kept apart instead of being read as a missing comment.
    return { written: false, failure: isDefiniteRejection(error) ? "refused" : "unconfirmed" };
  }
}

export async function writeItemIndex(index: ItemIndex, context: IndexContext, settled = 0): Promise<IndexWriteOutcome> {
  const { ref, read, deps, cwd } = context;
  const body = withNaxBotMarker(renderItemIndex(index, settled), "w-index");
  // Reserved: a spent budget must never cost the PR its index, and persisting the invalidation
  // before a reopen notice has to outlive the thread posts' allowance.
  return write(
    "w-index",
    context.pacer,
    async () => {
      const comment = read.indexComment ?? context.postedIndex;
      if (comment) await editComment(ref, comment, body, deps, cwd);
      else {
        const posted = await postPrComment(ref, body, deps, cwd);
        context.postedIndex = { id: posted.id, kind: "comment" };
      }
    },
    { reserved: true },
  );
}

export async function maintainItemIndex(
  input: ItemThreadsInput,
  keys: readonly string[],
  context: IndexContext,
  options: { keepReviewed?: boolean; settled?: number; pendingReopens?: ItemIndex["pendingReopens"] } = {},
): Promise<{ closed: number; failed: number; indexed: boolean; indexFailure?: IndexWriteFailure }> {
  const { ref, read, login, deps, cwd } = context;
  const reviewed = options.keepReviewed
    ? { reviewedHead: read.index?.reviewedHead, reviewedBase: read.index?.reviewedBase }
    : reviewedIndex(input, read.index);
  const index = await writeItemIndex(
    { keys, ...reviewed, pendingReopens: options.pendingReopens ?? read.index?.pendingReopens },
    context,
    options.settled ?? 0,
  );
  const outcome = {
    closed: 0,
    failed: index.written ? 0 : 1,
    indexed: index.written,
    // Passed on so the caller can tell a refused index write from an unconfirmed one.
    ...(index.failure === undefined ? {} : { indexFailure: index.failure }),
  };
  if (!index.written) return outcome;
  const current = new Set(keys);
  for (const item of read.items) {
    if (
      current.has(item.key) ||
      ownComments(item.thread.comments, login).some(({ key }) => key === closedKey(item.key))
    )
      continue;
    const closed = withNaxBotMarker(renderItemClosed(input.head ?? context.info.headSha), closedKey(item.key));
    const replied = await write(item.itemId, context.pacer, () => replyToThread(ref, item.thread, closed, deps, cwd));
    const resolved = await write(item.itemId, context.pacer, () => resolveThread(ref, item.thread, deps, cwd));
    outcome.failed += Number(!replied.written) + Number(!resolved.written);
    if (replied.written && resolved.written) outcome.closed++;
  }
  return outcome;
}
