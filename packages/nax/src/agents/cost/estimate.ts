/**
 * Tier-aware USD cost estimator.
 *
 * Relocated from `src/agents/native/models.ts` per US-001 so both the ACP and
 * native paths share one implementation. Behaviour matches the previous
 * native version:
 * - `cacheReadPer1M` / `cacheCreationPer1M` fall back to `inputPer1M` when
 *   absent.
 * - Tier selection: the highest `inputTokensAbove` whose threshold is strictly
 *   less than the total input-class usage wins for the WHOLE request; ties
 *   resolve to the higher threshold (the array is taken in declaration
 *   order, so the last tier whose threshold is exceeded is the winner).
 * - What counts toward the threshold: input + cacheRead + cacheCreation.
 *
 * `inputClassTokens` is re-exported from here so callers using
 * `@/agents/cost` get the helper without reaching into `./calculate`.
 */

import type { Pricing, PricingRates, TokenUsage } from "./standard-types";
import { inputClassTokens } from "./usage-math";

/**
 * `inputClassTokens` is re-exported from here so callers using
 * `estimateCostUsd` can size the prompt with the same definition tier
 * selection uses.
 */
export { inputClassTokens };

/**
 * One rate level after tier selection. Cache rates stay optional here: the
 * types say a catalog level always carries them, but the pre-S1-1 code
 * defended against a level without them and priced those tokens at the same
 * level's input rate. Keeping the fallback keeps that behaviour.
 */
interface EffectiveRates {
  readonly input: number;
  readonly output: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
}

/** The greatest `inputTokensAbove` the request's input-class total exceeds wins, for the whole request. */
function selectRates(rates: Pricing, totalInputClassTokens: number): EffectiveRates {
  let winner: EffectiveRates = rates;
  if (rates.tiers !== undefined) {
    let bestThreshold = Number.NEGATIVE_INFINITY;
    for (const tier of rates.tiers) {
      if (totalInputClassTokens > tier.inputTokensAbove && tier.inputTokensAbove > bestThreshold) {
        winner = tier;
        bestThreshold = tier.inputTokensAbove;
      }
    }
  }
  return winner;
}

function resolveRates(rates: Pricing, totalInputClassTokens: number): PricingRates {
  const effective = selectRates(rates, totalInputClassTokens);
  return {
    input: effective.input,
    output: effective.output,
    cacheRead: effective.cacheRead ?? effective.input,
    cacheWrite: effective.cacheWrite ?? effective.input,
  };
}

/**
 * Price one call. `costUsd` and `resolvedRates` come from one tier selection,
 * so recorded rates always reproduce the recorded cost.
 */
export function priceCall(usage: TokenUsage, rates: Pricing): { costUsd: number; resolvedRates: PricingRates } {
  const resolvedRates = resolveRates(rates, inputClassTokens(usage));

  const inputCost = (usage.inputTokens / 1_000_000) * resolvedRates.input;
  const outputCost = (usage.outputTokens / 1_000_000) * resolvedRates.output;
  const cacheReadCost = ((usage.cacheReadTokens ?? 0) / 1_000_000) * resolvedRates.cacheRead;
  const cacheWriteCost = ((usage.cacheWriteTokens ?? 0) / 1_000_000) * resolvedRates.cacheWrite;

  return {
    costUsd: inputCost + outputCost + cacheReadCost + cacheWriteCost,
    resolvedRates,
  };
}

export function estimateCostUsd(usage: TokenUsage, rates: Pricing): number {
  return priceCall(usage, rates).costUsd;
}
