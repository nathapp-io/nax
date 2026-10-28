/** Cancel fixed/verified rulings when a fully reviewed new head raises the item again. */
import { errorMessage } from "@nathapp/nax-agent/internal";
import {
  type ForgeDeps,
  hasWriteAccess,
  type PrRef,
  replyToThread,
  unresolveThread,
  withNaxBotMarker,
  writerCheck,
} from "@/forge";
import { getLogger } from "@/logger";
import type { ReadItemThreads } from "./item-thread-state";
import { REOPENED_BY_RERAISE, renderItemReopened, reopenKey } from "./item-threads";
import { reviewedIndex } from "./item-threads-index";
import type { ItemThreadsInput } from "./item-threads-post";

export interface ReopenContext {
  readonly ref: PrRef;
  readonly read: ReadItemThreads;
  readonly login: string;
  readonly deps: ForgeDeps;
  readonly cwd: string;
  readonly info: { readonly headSha: string };
}

export async function reopenReraisedItems(
  input: ItemThreadsInput,
  keys: readonly string[],
  context: ReopenContext,
): Promise<{ reopened: ReadonlySet<string>; failed: number }> {
  const reopened = new Set<string>();
  const head = reviewedIndex(input, context.read.index).reviewedHead;
  if (!head || head === context.read.index?.reviewedHead) return { reopened, failed: 0 };
  const { ref, read, deps, cwd } = context;
  const current = new Set(keys);
  const canWrite = writerCheck(context, hasWriteAccess, (login, error) => {
    getLogger()?.warn("item-threads", "[item-threads] Could not check ruling permission", { login, error });
  });
  let failed = 0;
  for (const item of read.items) {
    if (!current.has(item.key) || !item.ruling || !REOPENED_BY_RERAISE.has(item.ruling.disposition)) continue;
    const writers = await Promise.all(
      item.replies.map((reply) => canWrite({ login: reply.author, id: reply.authorId })),
    );
    if (writers.some(Boolean)) continue;
    reopened.add(item.key);
    try {
      const body = withNaxBotMarker(renderItemReopened(input.head ?? context.info.headSha), reopenKey(item.key));
      await replyToThread(ref, item.thread, body, deps, cwd);
      await unresolveThread(ref, item.thread, deps, cwd);
    } catch (error) {
      failed++;
      getLogger()?.warn("item-threads", "[item-threads] Reopen write failed", {
        itemId: item.itemId,
        error: errorMessage(error),
      });
    }
  }
  return { reopened, failed };
}
