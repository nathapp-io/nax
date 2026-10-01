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
 * The post-selection, post-fallback rates `priceCall` returns. Distinct from
 * the internal `EffectiveRates` shape above because its cache fields are
 * *required*: any undefined `cacheReadPer1M` / `cacheCreationPer1M` on the
 * winning row was substituted by `inputPer1M` during selection, so a reader
 * of `ResolvedRates` can multiply token counts by these numbers and get back
 * the recorded cost without re-running tier selection. This is what makes a
 * cost row's arithmetic verifiable (nax#1847 follow-up, US-001 AC8).
 */
export interface ResolvedRates {
  inputPer1M: number;
  outputPer1M: number;
  cacheReadPer1M: number;
  cacheCreationPer1M: number;
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
 * Resolve the per-1M rates that priced the call, with cache fields
 * substituted by `inputPer1M` where the rate card did not define them.
 *
 * Substituting here, rather than at multiplication time, is what makes the
 * recorded numbers arithmetic-verifiable: the downstream reader does not
 * need to know about the fallback rule.
 */
function resolveRates(rates: TokenPricing, totalInputClassTokens: number): ResolvedRates {
  const effective = selectRates(rates, totalInputClassTokens);
  return {
    inputPer1M: effective.inputPer1M,
    outputPer1M: effective.outputPer1M,
    cacheReadPer1M: effective.cacheReadPer1M ?? effective.inputPer1M,
    cacheCreationPer1M: effective.cacheCreationPer1M ?? effective.inputPer1M,
  };
}

/**
 * Price a request given token usage and a rate card.
 *
 * Returns the USD cost together with the exact per-1M rates that priced it —
 * tier selection applied, cache-rate fallback resolved. A downstream cost
 * row can stamp `resolvedRates` and the row's arithmetic stays verifiable
 * without re-running tier selection.
 *
 * Cache classes that the rate card does not price (`cacheReadPer1M` or
 * `cacheCreationPer1M` undefined) fall back to `inputPer1M`. The whole
 * request re-prices under any tier whose threshold the input-class usage
 * crosses — output tokens and both cache classes alike.
 */
export function priceCall(usage: TokenUsage, rates: TokenPricing): { costUsd: number; resolvedRates: ResolvedRates } {
  const totalInputClassTokens = inputClassTokens(usage);
  const resolvedRates = resolveRates(rates, totalInputClassTokens);

  const inputCost = (usage.inputTokens / 1_000_000) * resolvedRates.inputPer1M;
  const outputCost = (usage.outputTokens / 1_000_000) * resolvedRates.outputPer1M;
  const cacheReadCost = ((usage.cacheReadInputTokens ?? 0) / 1_000_000) * resolvedRates.cacheReadPer1M;
  const cacheCreationCost = ((usage.cacheCreationInputTokens ?? 0) / 1_000_000) * resolvedRates.cacheCreationPer1M;

  return {
    costUsd: inputCost + outputCost + cacheReadCost + cacheCreationCost,
    resolvedRates,
  };
}

/**
 * Compute USD cost for a request given token usage and a rate card.
 *
 * Thin wrapper over `priceCall`; returns its cost component so every
 * existing caller keeps its current contract. Cache-rate fallback, tier
 * selection, and the input-class token threshold are all owned by
 * `priceCall`.
 */
export function estimateCostUsd(usage: TokenUsage, rates: TokenPricing): number {
  return priceCall(usage, rates).costUsd;
}
