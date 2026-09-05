/**
 * Cost calculation functions for all agent adapters.
 */

import type { ModelTier } from "@/config/schema";
import { parseModelSpec } from "../model-spec";
import { COST_RATES, MODEL_PRICING } from "./pricing";
import type { CostEstimate, ModelCostRates, TokenUsage } from "./types";

/**
 * Estimate cost in USD based on token usage and model tier.
 *
 * @param modelTier - Model tier (fast/balanced/powerful)
 * @param inputTokens - Number of input tokens consumed
 * @param outputTokens - Number of output tokens generated
 * @param customRates - Optional custom rates (overrides tier defaults)
 * @returns Total cost in USD
 *
 * @example
 * ```ts
 * const cost = estimateCost("balanced", 10000, 5000);
 * // Sonnet 4.5: (10000/1M * $3.00) + (5000/1M * $15.00) = $0.105
 * ```
 */
export function estimateCost(
  modelTier: ModelTier,
  inputTokens: number,
  outputTokens: number,
  customRates?: ModelCostRates,
): number {
  const rates = customRates ?? COST_RATES[modelTier];
  const inputCost = (inputTokens / 1_000_000) * rates.inputPer1M;
  const outputCost = (outputTokens / 1_000_000) * rates.outputPer1M;
  return inputCost + outputCost;
}

/**
 * Fallback cost estimation based on runtime duration.
 *
 * Used when token usage cannot be parsed from agent output.
 * Provides conservative estimates using per-minute rates.
 *
 * @param modelTier - Model tier for cost calculation
 * @param durationMs - Agent runtime in milliseconds
 * @returns Cost estimate with 'fallback' confidence
 *
 * @example
 * ```ts
 * const estimate = estimateCostByDuration("balanced", 120000); // 2 minutes
 * // { cost: 0.10, confidence: 'fallback' }
 * // Sonnet: 2 min * $0.05/min = $0.10
 * ```
 */
export function estimateCostByDuration(modelTier: ModelTier, durationMs: number): CostEstimate {
  const costPerMinute: Record<ModelTier, number> = {
    fast: 0.01,
    balanced: 0.05,
    powerful: 0.15,
  };
  const minutes = durationMs / 60000;
  const cost = minutes * costPerMinute[modelTier];
  return {
    cost,
    confidence: "fallback",
  };
}

/**
 * Format cost estimate with confidence indicator for display.
 *
 * @param estimate - Cost estimate with confidence level
 * @returns Formatted cost string with confidence indicator
 *
 * @example
 * ```ts
 * formatCostWithConfidence({ cost: 0.12, confidence: 'exact' });
 * // "$0.12"
 *
 * formatCostWithConfidence({ cost: 0.15, confidence: 'estimated' });
 * // "~$0.15"
 *
 * formatCostWithConfidence({ cost: 0.05, confidence: 'fallback' });
 * // "~$0.05 (duration-based)"
 * ```
 */
export function formatCostWithConfidence(estimate: CostEstimate): string {
  const formattedCost = `$${estimate.cost.toFixed(2)}`;

  switch (estimate.confidence) {
    case "exact":
      return formattedCost;
    case "estimated":
      return `~${formattedCost}`;
    case "fallback":
      return `~${formattedCost} (duration-based)`;
  }
}

/** Coerce a token count to a finite number, falling back to 0. Defense in
 * depth (BUG-10): upstream guards in parser.ts / token-mapper.ts should
 * already keep non-numeric values out, but `addTokenUsage` is a cheap pure
 * function reachable from multiple call sites, so it validates its own
 * inputs rather than trusting the static TokenUsage type — a malformed
 * operand (e.g. a stringified number) would otherwise trigger `+`'s string
 * concatenation instead of numeric addition, and a genuinely non-numeric
 * value would propagate NaN into the running total. */
function toFiniteTokenCount(value: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Sum two internal TokenUsage values. Pure.
 * Optional cache fields are only included when at least one operand has a defined value,
 * preserving the zero-omit serialization semantics from the original adapter code. */
export function addTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const result: TokenUsage = {
    inputTokens: toFiniteTokenCount(a.inputTokens) + toFiniteTokenCount(b.inputTokens),
    outputTokens: toFiniteTokenCount(a.outputTokens) + toFiniteTokenCount(b.outputTokens),
  };
  // BUG-58: apply the same finite-number guard to the cache fields as
  // inputTokens/outputTokens above — `?? 0` alone only guards undefined/null,
  // not a malformed non-numeric operand (e.g. a stringified number), which
  // would otherwise hit `+`'s string-concatenation behavior here too.
  const cacheRead = toFiniteTokenCount(a.cacheReadInputTokens ?? 0) + toFiniteTokenCount(b.cacheReadInputTokens ?? 0);
  const cacheCreation =
    toFiniteTokenCount(a.cacheCreationInputTokens ?? 0) + toFiniteTokenCount(b.cacheCreationInputTokens ?? 0);
  if (cacheRead > 0 || a.cacheReadInputTokens !== undefined || b.cacheReadInputTokens !== undefined) {
    result.cacheReadInputTokens = cacheRead;
  }
  if (cacheCreation > 0 || a.cacheCreationInputTokens !== undefined || b.cacheCreationInputTokens !== undefined) {
    result.cacheCreationInputTokens = cacheCreation;
  }
  return result;
}

/**
 * Calculate USD cost from internal TokenUsage using per-model pricing.
 *
 * @param usage - Internal token usage (camelCase)
 * @param model - Model identifier (e.g., 'claude-sonnet-4', 'claude-haiku-4-5')
 * @returns Estimated cost in USD
 */
export function estimateCostFromTokenUsage(usage: TokenUsage, model: string): number {
  // #1464: nax profiles name codex models with a reasoning-effort suffix
  // ("gpt-5.6-luna[high]"); MODEL_PRICING is keyed on the bare id, so a rate
  // card can never be hit unless the suffix is stripped first. Parsing a bare
  // id is a no-op, so this is safe to apply unconditionally.
  const { model: bareModel } = parseModelSpec(model);
  const pricing = MODEL_PRICING[bareModel];

  if (!pricing) {
    // Fallback: use average rate for unknown models
    const fallbackInputRate = 3 / 1_000_000;
    const fallbackOutputRate = 15 / 1_000_000;
    const inputCost = (usage.inputTokens ?? 0) * fallbackInputRate;
    const outputCost = (usage.outputTokens ?? 0) * fallbackOutputRate;
    const cacheReadCost = (usage.cacheReadInputTokens ?? 0) * (0.5 / 1_000_000);
    const cacheCreationCost = (usage.cacheCreationInputTokens ?? 0) * (2 / 1_000_000);
    return inputCost + outputCost + cacheReadCost + cacheCreationCost;
  }

  // Convert $/1M rates to $/token
  const inputRate = pricing.input / 1_000_000;
  const outputRate = pricing.output / 1_000_000;
  const cacheReadRate = (pricing.cacheRead ?? pricing.input * 0.1) / 1_000_000;
  const cacheCreationRate = (pricing.cacheCreation ?? pricing.input * 0.33) / 1_000_000;

  const inputCost = (usage.inputTokens ?? 0) * inputRate;
  const outputCost = (usage.outputTokens ?? 0) * outputRate;
  const cacheReadCost = (usage.cacheReadInputTokens ?? 0) * cacheReadRate;
  const cacheCreationCost = (usage.cacheCreationInputTokens ?? 0) * cacheCreationRate;

  return inputCost + outputCost + cacheReadCost + cacheCreationCost;
}

/**
 * Which rate card `estimateCostFromTokenUsage` would use for `model`.
 *
 * Deliberately adjacent to that function: it re-states the same
 * `MODEL_PRICING[model]` predicate, so the two must be changed together. When
 * the table has no entry the estimator silently applies a generic
 * $3/$15-per-1M card, which is Sonnet-shaped and wrong for most third-party
 * models — July 2026 priced every `minimax/*` and `gpt-5.6-*` row that way,
 * giving per-row errors up to 21x. Recording the source makes an estimate built
 * on guessed rates distinguishable from one built on the model's real rates
 * (#1433).
 *
 * The US-004 widening adds `"catalog-rates"` and `"config-override"` so
 * producer-supplied values from `CompleteResult.pricingSource` /
 * `TurnResult.pricingSource` type-check through the cost subscriber. The
 * function itself never returns those values — it only consults
 * `MODEL_PRICING` — but the union must admit them so the cost row's
 * `pricingSource` field can carry the producer's report unchanged.
 *
 * @param model - Resolved model name, or undefined when nothing resolved one
 * @returns `"model-rates"` when priced from the table, `"fallback-rates"` when
 *          priced from the generic card, `"unknown-model"` when no model is known
 */
export function resolvePricingSource(
  model: string | undefined,
): "model-rates" | "fallback-rates" | "unknown-model" | "catalog-rates" | "config-override" {
  if (model === undefined || model === "" || model === "unknown") return "unknown-model";
  // #1464: same normalization as estimateCostFromTokenUsage, so the two stay
  // in agreement about which rate card produced the number.
  const { model: bareModel } = parseModelSpec(model);
  return MODEL_PRICING[bareModel] ? "model-rates" : "fallback-rates";
}

/**
 * Tokens the provider counted as part of the prompt.
 *
 * Cache reads and writes are prompt tokens that the provider reports
 * separately because it prices them differently — not tokens that were
 * absent from the request. Any consumer asking "how big was the prompt"
 * needs all three; `inputTokens` alone answers a different question and,
 * under prompt caching, collapses to near zero (nax#1852).
 *
 * Output is deliberately excluded: this measures the prompt, not the call.
 */
export function inputClassTokens(usage: TokenUsage): number {
  return usage.inputTokens + (usage.cacheReadInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0);
}
