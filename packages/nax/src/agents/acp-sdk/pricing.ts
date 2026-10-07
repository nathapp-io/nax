/**
 * Spend on the ACP SDK transport (S4b spec §7.3). The backend reports each
 * prompt's tokens and, for Claude, the agent's own cost (costSource
 * "reported"); a failed prompt's spend rides on the thrown error
 * (attachTurnSpend). nax sums them across its loop: estimatedCostUsd is always
 * tokens x the session's rate card (assembleTurnResult / failedSpendFields), and
 * the reported cost passes through as exactCostUsd.
 */
import { readTurnSpend, type TurnResult } from "@nathapp/nax-agent";
import { addTokenUsage, estimateCostUsd, type RateCard, type TokenUsage } from "../cost";

export interface Spend {
  readonly tokenUsage: TokenUsage;
  /** Sum of the reported costs; undefined until some prompt reported one. */
  readonly exactCostUsd: number | undefined;
}

export const NO_SPEND: Spend = Object.freeze({
  tokenUsage: Object.freeze({ inputTokens: 0, outputTokens: 0 }),
  exactCostUsd: undefined,
});

/** One successful backend prompt. Its estimatedCostUsd is the agent's figure when costSource is "reported". */
export function spendOfResult(result: Pick<TurnResult, "tokenUsage" | "estimatedCostUsd" | "costSource">): Spend {
  return {
    tokenUsage: result.tokenUsage,
    exactCostUsd: result.costSource === "reported" ? result.estimatedCostUsd : undefined,
  };
}

/** One failed backend prompt: the spend attached to its error, or nothing. */
export function spendOfError(err: unknown): Spend {
  const spend = readTurnSpend(err);
  if (spend === undefined) return NO_SPEND;
  return { tokenUsage: spend.tokenUsage, exactCostUsd: spend.costSource === "reported" ? spend.costUsd : undefined };
}

export function addSpend(a: Spend, b: Spend): Spend {
  const exact =
    a.exactCostUsd === undefined && b.exactCostUsd === undefined
      ? undefined
      : (a.exactCostUsd ?? 0) + (b.exactCostUsd ?? 0);
  return { tokenUsage: addTokenUsage(a.tokenUsage, b.tokenUsage), exactCostUsd: exact };
}

/** The spend fields a SessionTurnError carries, so burned tokens are recorded (BUG-57). */
export function failedSpendFields(
  spend: Spend,
  rateCard: RateCard,
): {
  tokenUsage: TokenUsage;
  estimatedCostUsd: number;
  exactCostUsd: number | undefined;
  pricingSource: RateCard["source"];
} {
  const hasUsage = spend.tokenUsage.inputTokens > 0 || spend.tokenUsage.outputTokens > 0;
  return {
    tokenUsage: spend.tokenUsage,
    estimatedCostUsd: hasUsage ? estimateCostUsd(spend.tokenUsage, rateCard.rates) : 0,
    exactCostUsd: spend.exactCostUsd,
    pricingSource: rateCard.source,
  };
}
