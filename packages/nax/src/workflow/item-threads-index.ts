/** Durable publish-time index and obsolete-thread closures. These replies are not rulings. */
import { errorMessage } from "@nathapp/nax-agent/internal";
import type { ForgeDeps, PrRef } from "@/forge";
import { editComment, ownComments, postPrComment, replyToThread, resolveThread, withNaxBotMarker } from "@/forge";
import { getLogger } from "@/logger";
import type { ReadItemThreads } from "./item-thread-state";
import { closedKey, type ItemIndex, renderItemClosed, renderItemIndex } from "./item-threads";
import type { ItemThreadsInput } from "./item-threads-post";

interface IndexContext {
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

async function write(itemId: string, action: () => Promise<unknown>): Promise<boolean> {
  try {
    await action();
    return true;
  } catch (error) {
    getLogger()?.warn("item-threads", "[item-threads] Index or closing write failed", {
      itemId,
      error: errorMessage(error),
    });
    return false;
  }
}

export async function maintainItemIndex(
  input: ItemThreadsInput,
  keys: readonly string[],
  context: IndexContext,
  options: { keepReviewed?: boolean; settled?: number } = {},
): Promise<{ closed: number; failed: number }> {
  const { ref, read, login, deps, cwd } = context;
  const reviewed = options.keepReviewed
    ? { reviewedHead: read.index?.reviewedHead, reviewedBase: read.index?.reviewedBase }
    : reviewedIndex(input, read.index);
  const body = withNaxBotMarker(renderItemIndex({ keys, ...reviewed }, options.settled ?? 0), "w-index");
  const indexed = await write("w-index", () =>
    read.indexComment ? editComment(ref, read.indexComment, body, deps, cwd) : postPrComment(ref, body, deps, cwd),
  );
  const outcome = { closed: 0, failed: indexed ? 0 : 1 };
  if (!indexed) return outcome;
  const current = new Set(keys);
  for (const item of read.items) {
    if (
      current.has(item.key) ||
      ownComments(item.thread.comments, login).some(({ key }) => key === closedKey(item.key))
    )
      continue;
    const closed = withNaxBotMarker(renderItemClosed(input.head ?? context.info.headSha), closedKey(item.key));
    const replied = await write(item.itemId, () => replyToThread(ref, item.thread, closed, deps, cwd));
    const resolved = await write(item.itemId, () => resolveThread(ref, item.thread, deps, cwd));
    outcome.failed += Number(!replied) + Number(!resolved);
    if (replied && resolved) outcome.closed++;
  }
  return outcome;
}
