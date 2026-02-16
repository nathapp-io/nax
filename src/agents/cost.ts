/**
 * Cost Tracking
 *
 * Token-based cost estimation for AI coding agents.
 * Parses agent output for token usage and calculates costs.
 */

import type { ModelTier } from "../config/schema";

/** Cost rates per 1M tokens (USD) */
export interface ModelCostRates {
  inputPer1M: number;
  outputPer1M: number;
}

/** Token usage data */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Model tier cost rates (as of 2025-01) */
export const COST_RATES: Record<ModelTier, ModelCostRates> = {
  fast: {
    // Haiku 4.5
    inputPer1M: 0.80,
    outputPer1M: 4.00,
  },
  balanced: {
    // Sonnet 4.5
    inputPer1M: 3.00,
    outputPer1M: 15.00,
  },
  powerful: {
    // Opus 4
    inputPer1M: 15.00,
    outputPer1M: 75.00,
  },
};

/**
 * Parse Claude Code output for token usage.
 * Looks for patterns like:
 * - "Input tokens: 1234"
 * - "Output tokens: 5678"
 * - "Total tokens: 6912"
 */
export function parseTokenUsage(output: string): TokenUsage | null {
  const inputMatch = output.match(/input\s+tokens?:\s*(\d+)/i);
  const outputMatch = output.match(/output\s+tokens?:\s*(\d+)/i);

  if (!inputMatch || !outputMatch) {
    return null;
  }

  return {
    inputTokens: Number.parseInt(inputMatch[1], 10),
    outputTokens: Number.parseInt(outputMatch[1], 10),
  };
}

/**
 * Estimate cost in USD based on token usage.
 */
export function estimateCost(
  modelTier: ModelTier,
  inputTokens: number,
  outputTokens: number,
): number {
  const rates = COST_RATES[modelTier];
  const inputCost = (inputTokens / 1_000_000) * rates.inputPer1M;
  const outputCost = (outputTokens / 1_000_000) * rates.outputPer1M;
  return inputCost + outputCost;
}

/**
 * Estimate cost from agent output (parses tokens, then calculates).
 * Returns 0 if tokens cannot be parsed.
 */
export function estimateCostFromOutput(
  modelTier: ModelTier,
  output: string,
): number {
  const usage = parseTokenUsage(output);
  if (!usage) {
    return 0;
  }
  return estimateCost(modelTier, usage.inputTokens, usage.outputTokens);
}

/**
 * Fallback cost estimation based on runtime duration.
 * Used when token usage cannot be parsed from output.
 *
 * Rough estimates per minute of agent runtime:
 * - cheap (Haiku): ~$0.01/min
 * - standard (Sonnet): ~$0.05/min
 * - premium (Opus): ~$0.15/min
 */
export function estimateCostByDuration(
  modelTier: ModelTier,
  durationMs: number,
): number {
  const costPerMinute: Record<ModelTier, number> = {
    fast: 0.01,
    balanced: 0.05,
    powerful: 0.15,
  };
  const minutes = durationMs / 60000;
  return minutes * costPerMinute[modelTier];
}
