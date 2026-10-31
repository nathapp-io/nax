/** Read-only PR ruling input for local promote; shared ownership and settlement remain authoritative. */
import { errorMessage } from "@nathapp/nax-agent/internal";
import { NaxError } from "@/errors";
import {
  type ForgeDeps,
  hasWriteAccess,
  listPrComments,
  listReviewThreads,
  type PrComment,
  type PrRef,
  prNumberFromUrl,
  readCurrentUser,
  resolvePrRef,
} from "@/forge";
import { warnOrDefer } from "@/logger";
import { type DecisionEntry, mergeDecisions, parseDecisionEntries, sidecarKindFor } from "./decisions-sidecar";
import { readItemThreads, type SettledItems, settleItemThreads } from "./item-thread-state";
import { itemKey } from "./item-threads";
import { CI_ITEM_ID } from "./open-items";
import type { OpenItem } from "./types";

export type PrRulingsReport =
  | { readonly read: true; readonly count: number }
  | { readonly read: false; readonly error: string };

export async function canRule(
  ref: PrRef,
  comment: PrComment,
  context: { deps: ForgeDeps; cwd: string },
): Promise<boolean> {
  try {
    return await hasWriteAccess(ref, { login: comment.author, id: comment.authorId }, context.deps, context.cwd);
  } catch (error) {
    warnOrDefer(
      "workflow-promote",
      `[workflow-promote] Reply access lookup failed for ${comment.author}; denying access: ${errorMessage(error)}`,
    );
    return false;
  }
}

function entriesFor(items: readonly OpenItem[], settled: SettledItems): DecisionEntry[] {
  const current = new Map(items.filter((item) => item.id !== CI_ITEM_ID).map((item) => [itemKey(item), item]));
  const entries = settled.settled.flatMap(({ key, ruling }) => {
    const item = current.get(key);
    return item
      ? [
          {
            id: item.id,
            kind: sidecarKindFor(item),
            disposition: ruling.disposition,
            reason: ruling.reason,
            ...(ruling.disposition === "fixed" ? { sha: ruling.sha } : {}),
          },
        ]
      : [];
  });
  // Collapse duplicate threads by id before applying the same validation used for local entries.
  return parseDecisionEntries(mergeDecisions([], entries));
}

export async function readPromoteRulings(input: {
  readonly url: string;
  readonly cwd: string;
  readonly deps: ForgeDeps;
  readonly items: readonly OpenItem[];
  readonly local: readonly DecisionEntry[];
}): Promise<{ entries: readonly DecisionEntry[]; prRulings: PrRulingsReport }> {
  const { url, cwd, deps, items, local } = input;
  try {
    const number = prNumberFromUrl(url);
    if (number === null)
      throw new NaxError("[workflow-promote] Cannot read PR number", "FORGE_PR_REF_UNRESOLVED", {
        stage: "workflow-promote",
        url,
      });
    const ref = await resolvePrRef(number, deps, cwd);
    const [user, threads, comments] = await Promise.all([
      readCurrentUser(ref, deps, cwd),
      listReviewThreads(ref, deps, cwd),
      listPrComments(ref, deps, cwd),
    ]);
    const settled = await settleItemThreads(readItemThreads(threads, comments, user.login), (comment) =>
      canRule(ref, comment, { deps, cwd }),
    );
    const pr = entriesFor(items, settled);
    const localIds = new Set(local.map((entry) => entry.id));
    return {
      entries: mergeDecisions(pr, local),
      prRulings: { read: true, count: pr.filter((entry) => !localIds.has(entry.id)).length },
    };
  } catch (error) {
    const message = errorMessage(error);
    warnOrDefer(
      "workflow-promote",
      `[workflow-promote] PR ruling read failed for ${url}; using sidecar only: ${message}`,
    );
    return { entries: local, prRulings: { read: false, error: message } };
  }
}
