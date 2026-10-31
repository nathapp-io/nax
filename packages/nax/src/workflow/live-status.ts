/** Read-only live workflow PR state; ownership, indexing and writer policy stay shared. */
import { errorMessage } from "@nathapp/nax-agent/internal";
import { NaxError } from "@/errors";
import {
  type ForgeDeps,
  listPrComments,
  listReviewThreads,
  prNumberFromUrl,
  readCurrentUser,
  resolvePrRef,
} from "@/forge";
import { readItemThreads, type SettledItems, settleItemThreads } from "./item-thread-state";
import { readPrState } from "./pr-state";
import { canRule } from "./promote-rulings";
import type { OpenItem } from "./types";

export type LiveStatus =
  | {
      readonly source: "live";
      readonly isDraft: boolean;
      /** Item ids whose thread carries a ruling that closes the item. */
      readonly settled: readonly { readonly id: string; readonly disposition: string }[];
      /** Item ids that are confirmed advisor items with no fix-closing reply. */
      readonly awaitingFix: readonly string[];
    }
  | { readonly source: "run-record"; readonly error: string };

function partition(items: readonly OpenItem[], state: SettledItems) {
  const ids = new Set(items.map((item) => item.id));
  const settled: { id: string; disposition: string }[] = [];
  const awaitingFix: string[] = [];
  for (const item of state.settled) {
    if (!ids.has(item.itemId)) continue;
    if (item.kind === "advisor" && item.ruling.disposition === "confirmed" && !item.fixClosed) {
      awaitingFix.push(item.itemId);
    } else {
      settled.push({ id: item.itemId, disposition: item.ruling.disposition });
    }
  }
  return { settled, awaitingFix };
}

/** Some forge readers wrap thrown I/O failures without including their message. */
function failureMessage(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    messages.push(errorMessage(current));
    current =
      current instanceof NaxError ? current.context?.cause : current instanceof Error ? current.cause : undefined;
  }
  return messages.join(": ");
}

export async function readLiveStatus(input: {
  readonly url: string;
  readonly cwd: string;
  readonly deps: ForgeDeps;
  readonly items: readonly OpenItem[];
}): Promise<LiveStatus> {
  const { url, cwd, deps, items } = input;
  try {
    const number = prNumberFromUrl(url);
    if (number === null) return { source: "run-record", error: "[workflow-status] Cannot read PR number" };
    const ref = await resolvePrRef(number, deps, cwd);
    const [pr, user, threads, comments] = await Promise.all([
      readPrState(ref.forge, url, deps, cwd),
      readCurrentUser(ref, deps, cwd),
      listReviewThreads(ref, deps, cwd),
      listPrComments(ref, deps, cwd),
    ]);
    const read = readItemThreads(threads, comments, user.login);
    if (!read.index) return { source: "run-record", error: "no nax item index on this PR" };
    const state = await settleItemThreads(read, (comment) => canRule(ref, comment, { deps, cwd }));
    return { source: "live", isDraft: pr.isDraft, ...partition(items, state) };
  } catch (error) {
    return { source: "run-record", error: failureMessage(error) };
  }
}
