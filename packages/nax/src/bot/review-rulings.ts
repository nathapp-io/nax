import { errorMessage } from "@nathapp/nax-agent/internal";
import { hasNaxWorkflowMarker, ownComments, type PrThread } from "@/forge";
import { getLogger } from "@/logger";
import type { BotSettledRuling } from "@/prompts";
import type { PrStepContext } from "../workflow/branch-step-context";
import { type ItemIndex, parseItemOpener } from "../workflow/item-threads";
import type { PrCheckout } from "./checkout";
import type { PostReviewInput } from "./post";
import { earlierIssue } from "./post-earlier";
import { rulingModelReader } from "./ruling-reader";
import type { RecordRulingsInput, RecordRulingsOutcome, recordPrRulings } from "./rulings";

/** Ruling reads are privileged and best-effort; an absent outcome must not invent counts. */
export async function readReviewRulings(
  input: Omit<RecordRulingsInput, "readModel"> & { staticMode: boolean; ctx: PrStepContext },
  record: typeof recordPrRulings,
): Promise<
  Pick<PostReviewInput, "itemEarlier" | "rulings"> & { reviewedIndex?: ItemIndex; settled?: BotSettledRuling[] }
> {
  const { staticMode, ctx, ...raw } = input;
  if (staticMode || !hasNaxWorkflowMarker(raw.info.body)) return {};
  try {
    const outcome = await record({
      ...raw,
      readModel: rulingModelReader(ctx),
    });
    return {
      reviewedIndex: outcome.index,
      settled: outcome.settled.map((item) => ({
        id: item.itemId,
        kind: item.kind,
        issue: parseItemOpener(item.thread.comments[0]?.body ?? "")?.issue ?? earlierIssue(item.thread),
        disposition: item.ruling.disposition,
        reason: item.ruling.reason,
        ...(item.ruling.sha !== undefined && { sha: item.ruling.sha }),
      })),
      itemEarlier: rulingEarlier(outcome, raw.login),
      rulings: { recorded: outcome.recorded.length, open: outcome.open.length, asked: outcome.asked },
    };
  } catch (error) {
    getLogger().warn("bot", "Could not record PR rulings", { pr: raw.ref.number, error: errorMessage(error) });
    return {};
  }
}

/** Preserve forge order within each item, but never expose unauthorized replies to review. */
export function rulingEarlier(outcome: RecordRulingsOutcome, login: string): PrThread[] {
  return outcome.open.flatMap((item) => {
    if (item.kind !== "finding" && item.kind !== "ruling") return [];
    const own = new Set(ownComments(item.thread.comments, login).map(({ comment }) => comment.id));
    const kept = new Set(item.kept.map(({ id }) => id));
    return [
      {
        ...item.thread,
        comments: item.thread.comments.filter(
          (comment, index) => index === 0 || own.has(comment.id) || kept.has(comment.id),
        ),
      },
    ];
  });
}

/** What a bot review actually has to look at: everything, the range since an earlier review, or talk only. */
export type BotReviewScope = "full" | "incremental" | "conversation-only";

/**
 * Classify a review from the same inputs `runPrReview` receives (nax#2667). The
 * caller already narrowed `rangeBase`; this only names the resulting scope so the
 * prompt, the artifact and the summary cannot disagree about it.
 */
export function reviewScopeOf(input: {
  readonly rangeBase?: string;
  readonly mergeBase: string;
  readonly conversationOnly?: boolean;
}): BotReviewScope {
  if (input.conversationOnly === true) return "conversation-only";
  if (input.rangeBase !== undefined && input.rangeBase !== input.mergeBase) return "incremental";
  return "full";
}

/** Only the privileged recorder's validated provenance can narrow a code review. */
export async function reviewRange(
  input: { index?: ItemIndex; checkout: PrCheckout; head: string },
  isAncestor: (dir: string, ancestor: string, head: string) => Promise<boolean>,
): Promise<{ rangeBase: string; conversationOnly?: boolean }> {
  const { index, checkout, head } = input;
  const full = { rangeBase: checkout.mergeBase };
  const reviewedHead = index?.reviewedHead;
  const reviewedBase = index?.reviewedBase;
  if (
    !reviewedHead ||
    !reviewedBase ||
    !/^[a-fA-F0-9]{40}$/.test(reviewedHead) ||
    !/^[a-fA-F0-9]{40}$/.test(reviewedBase)
  )
    return full;
  try {
    if (!(await isAncestor(checkout.worktree, reviewedHead, head))) return full;
    if (!(await isAncestor(checkout.worktree, reviewedBase, checkout.mergeBase))) return full;
    return reviewedHead === head ? { rangeBase: reviewedHead, conversationOnly: true } : { rangeBase: reviewedHead };
  } catch (error) {
    getLogger().warn("bot", "Could not check reviewed ancestry; reviewing full range", { error: errorMessage(error) });
    return full;
  }
}
