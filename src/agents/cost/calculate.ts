/**
 * Cost calculation functions for all agent adapters.
 */

import type { ModelTier } from "../../config/schema";
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

/** Sum two internal TokenUsage values. Pure.
 * Optional cache fields are only included when at least one operand has a defined value,
 * preserving the zero-omit serialization semantics from the original adapter code. */
export function addTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const result: TokenUsage = {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
  const cacheRead = (a.cacheReadInputTokens ?? 0) + (b.cacheReadInputTokens ?? 0);
  const cacheCreation = (a.cacheCreationInputTokens ?? 0) + (b.cacheCreationInputTokens ?? 0);
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
  const pricing = MODEL_PRICING[model];

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
