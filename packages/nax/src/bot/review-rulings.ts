import { errorMessage } from "@nathapp/nax-agent/internal";
import { hasNaxWorkflowMarker, ownComments, type PrThread } from "@/forge";
import { getLogger } from "@/logger";
import { botRulingReadOp } from "@/operations";
import type { PrStepContext } from "../workflow/branch-step-context";
import { _workflowDeps } from "../workflow/step-context";
import { botModel } from "./models";
import type { PostReviewInput } from "./post";
import type { RecordRulingsInput, RecordRulingsOutcome, recordPrRulings } from "./rulings";

/** Ruling reads are privileged and best-effort; an absent outcome must not invent counts. */
export async function readReviewRulings(
  input: Omit<RecordRulingsInput, "readModel"> & { staticMode: boolean; ctx: PrStepContext },
  record: typeof recordPrRulings,
): Promise<Pick<PostReviewInput, "itemEarlier" | "rulings">> {
  const { staticMode, ctx, ...raw } = input;
  if (staticMode || !hasNaxWorkflowMarker(raw.info.body)) return {};
  try {
    const outcome = await record({
      ...raw,
      readModel: (value) =>
        _workflowDeps.callOp(ctx.callCtx, botRulingReadOp, {
          ...value,
          model: botModel(ctx.config, "rulings"),
        }),
    });
    return {
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
