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

import type { TokenPricing } from "@/config/schema-types";
import { inputClassTokens } from "./calculate";
import type { TokenUsage } from "./types";

export { inputClassTokens };

/**
 * The per-1M rates picked by `selectRates`. Same shape as a `TokenPricingTier`
 * minus `inputTokensAbove`, which only the threshold-typed tier carries; the
 * caller doesn't need it.
 */
interface EffectiveRates {
  inputPer1M: number;
  outputPer1M: number;
  cacheReadPer1M?: number;
  cacheCreationPer1M?: number;
}

/**
 * Pick the rate row to apply to the whole request.
 *
 * `rates.tiers` is an ordered list of overrides (nax#1847); the largest
 * `inputTokensAbove` whose threshold is strictly less than the input-class
 * usage wins. Strictly less matches nax-ai's own `> inputTokensAbove`
 * semantics ("Applies when total input usage EXCEEDS this token count"):
 * a request landing exactly on the threshold does not cross it, so the base
 * rates win.
 *
 * Selecting the *highest* matching threshold — not overwriting on every
 * match — keeps the contract order-independent. The catalog passes tiers
 * through verbatim, so an upstream that emits them out of declaration
 * order still applies the largest one that fires.
 */
function selectRates(rates: TokenPricing, totalInputClassTokens: number): EffectiveRates {
  let winner: EffectiveRates = {
    inputPer1M: rates.inputPer1M,
    outputPer1M: rates.outputPer1M,
    cacheReadPer1M: rates.cacheReadPer1M,
    cacheCreationPer1M: rates.cacheCreationPer1M,
  };
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

/**
 * Compute USD cost for a request given token usage and a rate card.
 *
 * Cache classes that the rate card does not price (`cacheReadPer1M` or
 * `cacheCreationPer1M` undefined) fall back to `inputPer1M`. The whole
 * request re-prices under any tier whose threshold the input-class usage
 * crosses — output tokens and both cache classes alike.
 */
export function estimateCostUsd(usage: TokenUsage, rates: TokenPricing): number {
  const effective = selectRates(rates, inputClassTokens(usage));
  const inputRate = effective.inputPer1M;
  const outputRate = effective.outputPer1M;
  const cacheReadRate = effective.cacheReadPer1M ?? inputRate;
  const cacheCreationRate = effective.cacheCreationPer1M ?? inputRate;

  const inputCost = (usage.inputTokens / 1_000_000) * inputRate;
  const outputCost = (usage.outputTokens / 1_000_000) * outputRate;
  const cacheReadCost = ((usage.cacheReadInputTokens ?? 0) / 1_000_000) * cacheReadRate;
  const cacheCreationCost = ((usage.cacheCreationInputTokens ?? 0) / 1_000_000) * cacheCreationRate;

  return inputCost + outputCost + cacheReadCost + cacheCreationCost;
}
