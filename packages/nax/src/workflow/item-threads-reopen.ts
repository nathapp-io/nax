/** Reopen re-raised closures, newly reviewed fixed/verified rulings, and incomplete unresolve writes. */
import { errorMessage } from "@nathapp/nax-agent/internal";
import {
  type ForgeDeps,
  hasWriteAccess,
  ownComments,
  type PrRef,
  replyToThread,
  unresolveThread,
  withNaxBotMarker,
  writerCheck,
} from "@/forge";
import { getLogger } from "@/logger";
import type { ItemThread, ReadItemThreads } from "./item-thread-state";
import { closedKey, REOPENED_BY_RERAISE, renderItemReopened, reopenKey } from "./item-threads";
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

async function reopenAction(
  item: ItemThread,
  context: { login: string; changed: boolean; canWrite: ReturnType<typeof writerCheck> },
): Promise<"notice" | "unresolve" | undefined> {
  const last = ownComments(item.thread.comments, context.login).at(-1)?.key;
  if (last === reopenKey(item.key)) return item.thread.resolved ? "unresolve" : undefined;
  if (last === closedKey(item.key)) return "notice";
  if (!context.changed || !item.ruling || !REOPENED_BY_RERAISE.has(item.ruling.disposition)) return undefined;
  const writers = await Promise.all(
    item.replies.map((reply) => context.canWrite({ login: reply.author, id: reply.authorId })),
  );
  return writers.some(Boolean) ? undefined : "notice";
}

export async function reopenReraisedItems(
  input: ItemThreadsInput,
  keys: readonly string[],
  context: ReopenContext,
): Promise<{ reopened: ReadonlySet<string>; failed: number }> {
  const reopened = new Set<string>();
  const head = reviewedIndex(input, context.read.index).reviewedHead;
  const changed = Boolean(head && head !== context.read.index?.reviewedHead);
  const { ref, read, deps, cwd } = context;
  const current = new Set(keys);
  const canWrite = writerCheck(context, hasWriteAccess, (login, error) => {
    getLogger()?.warn("item-threads", "[item-threads] Could not check ruling permission", { login, error });
  });
  let failed = 0;
  for (const item of read.items) {
    if (!current.has(item.key)) continue;
    const action = await reopenAction(item, { login: context.login, changed, canWrite });
    if (!action) continue;
    reopened.add(item.key);
    try {
      if (action === "notice") {
        const body = withNaxBotMarker(renderItemReopened(input.head ?? context.info.headSha), reopenKey(item.key));
        await replyToThread(ref, item.thread, body, deps, cwd);
      }
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
