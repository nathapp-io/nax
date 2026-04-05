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
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
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

/**
 * Token usage from an ACP session's cumulative_token_usage field.
 * Uses snake_case to match the ACP wire format.
 */
export interface SessionTokenUsage {
  input_tokens: number;
  output_tokens: number;
  /** Cache read tokens — billed at a reduced rate */
  cache_read_input_tokens?: number;
  /** Cache creation tokens — billed at a higher creation rate */
  cache_creation_input_tokens?: number;
}
