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
 * Per-model pricing in $/1M tokens: { input, output }
 */
const MODEL_PRICING: Record<string, { input: number; output: number; cacheRead?: number; cacheCreation?: number }> = {
  // Anthropic Claude models
  "claude-sonnet-4": { input: 3, output: 15 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "claude-haiku": { input: 0.8, output: 4.0, cacheRead: 0.1, cacheCreation: 1.0 },
  "claude-haiku-4-5": { input: 0.8, output: 4.0, cacheRead: 0.1, cacheCreation: 1.0 },
  "claude-opus": { input: 15, output: 75 },
  "claude-opus-4": { input: 15, output: 75 },

  // OpenAI models
  "gpt-4.1": { input: 10, output: 30 },
  "gpt-4": { input: 30, output: 60 },
  "gpt-3.5-turbo": { input: 0.5, output: 1.5 },

  // Google Gemini
  "gemini-2.5-pro": { input: 0.075, output: 0.3 },
  "gemini-2-pro": { input: 0.075, output: 0.3 },

  // OpenAI Codex
  codex: { input: 0.02, output: 0.06 },
  "code-davinci-002": { input: 0.02, output: 0.06 },
};

/**
 * Calculate USD cost from ACP session token counts using per-model pricing.
 *
 * @param usage - Token counts from cumulative_token_usage
 * @param model - Model identifier (e.g., 'claude-sonnet-4', 'claude-haiku-4-5')
 * @returns Estimated cost in USD
 */
export function estimateCostFromTokenUsage(usage: SessionTokenUsage, model: string): number {
  const pricing = MODEL_PRICING[model];

  if (!pricing) {
    // Fallback: use average rate for unknown models
    // Average of known rates: ~$5/1M tokens combined
    const fallbackInputRate = 3 / 1_000_000;
    const fallbackOutputRate = 15 / 1_000_000;
    const inputCost = (usage.input_tokens ?? 0) * fallbackInputRate;
    const outputCost = (usage.output_tokens ?? 0) * fallbackOutputRate;
    const cacheReadCost = (usage.cache_read_input_tokens ?? 0) * (0.5 / 1_000_000);
    const cacheCreationCost = (usage.cache_creation_input_tokens ?? 0) * (2 / 1_000_000);
    return inputCost + outputCost + cacheReadCost + cacheCreationCost;
  }

  // Convert $/1M rates to $/token
  const inputRate = pricing.input / 1_000_000;
  const outputRate = pricing.output / 1_000_000;
  const cacheReadRate = (pricing.cacheRead ?? pricing.input * 0.1) / 1_000_000;
  const cacheCreationRate = (pricing.cacheCreation ?? pricing.input * 0.33) / 1_000_000;

  const inputCost = (usage.input_tokens ?? 0) * inputRate;
  const outputCost = (usage.output_tokens ?? 0) * outputRate;
  const cacheReadCost = (usage.cache_read_input_tokens ?? 0) * cacheReadRate;
  const cacheCreationCost = (usage.cache_creation_input_tokens ?? 0) * cacheCreationRate;

  return inputCost + outputCost + cacheReadCost + cacheCreationCost;
}
