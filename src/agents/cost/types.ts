/**
 * Cost tracking types — shared across all agent adapters.
 */

import type { ModelTier } from "../../config/schema";

export type { ModelTier };

/** Cost rates per 1M tokens (USD) */
export interface ModelCostRates {
  inputPer1M: number;
  outputPer1M: number;
}

/** Token usage data (camelCase — nax-internal representation) */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

/** Cost estimate with confidence indicator */
export interface CostEstimate {
  cost: number;
  confidence: "exact" | "estimated" | "fallback";
}

/** Token usage with confidence indicator */
export interface TokenUsageWithConfidence {
  inputTokens: number;
  outputTokens: number;
  confidence: "exact" | "estimated";
}
