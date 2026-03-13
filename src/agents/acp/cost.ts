/**
 * ACP cost estimation from token usage.
 *
 * Stub — implementation in ACP-006.
 */

/**
 * Token usage data from an ACP session's cumulative_token_usage field.
 */
export interface SessionTokenUsage {
  input_tokens: number;
  output_tokens: number;
  /** Cache read tokens — billed at a reduced rate */
  cache_read_input_tokens?: number;
  /** Cache creation tokens — billed at a higher creation rate */
  cache_creation_input_tokens?: number;
}

/**
 * Calculate USD cost from ACP session token counts using per-model pricing.
 *
 * @param usage - Token counts from cumulative_token_usage
 * @param model - Model identifier (e.g., 'claude-sonnet-4', 'claude-haiku-4-5')
 * @returns Estimated cost in USD
 */
export function estimateCostFromTokenUsage(_usage: SessionTokenUsage, _model: string): number {
  throw new Error("[acp-cost] estimateCostFromTokenUsage: not implemented");
}
