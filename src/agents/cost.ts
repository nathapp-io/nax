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
 * Supports multiple formats:
 * - JSON: {"usage": {"input_tokens": 1234, "output_tokens": 5678}}
 * - Markdown: "Input tokens: 1234" / "Output tokens: 5678"
 * - Plain: "input: 1234, output: 5678"
 *
 * Uses specific regex patterns to reduce false positives (BUG-3).
 */
export function parseTokenUsage(output: string): TokenUsage | null {
  // Try JSON format first (most reliable)
  try {
    const jsonMatch = output.match(/\{[^}]*"usage"\s*:\s*\{[^}]*"input_tokens"\s*:\s*(\d+)[^}]*"output_tokens"\s*:\s*(\d+)[^}]*\}[^}]*\}/);
    if (jsonMatch) {
      return {
        inputTokens: Number.parseInt(jsonMatch[1], 10),
        outputTokens: Number.parseInt(jsonMatch[2], 10),
      };
    }

    // Try parsing as full JSON object
    const lines = output.split('\n');
    for (const line of lines) {
      if (line.trim().startsWith('{')) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.usage?.input_tokens && parsed.usage?.output_tokens) {
            return {
              inputTokens: parsed.usage.input_tokens,
              outputTokens: parsed.usage.output_tokens,
            };
          }
        } catch {
          // Not valid JSON, continue
        }
      }
    }
  } catch {
    // JSON parsing failed, try regex patterns
  }

  // Try specific markdown-style patterns (more specific to reduce false positives)
  // Match "Input tokens: 1234" or "input_tokens: 1234" or "INPUT TOKENS: 1234"
  // Use word boundary at start, require colon or space after keyword, then digits
  const inputMatch = output.match(/\b(?:input|input_tokens)\s*:\s*(\d{2,})|(?:input)\s+(?:tokens?)\s*:\s*(\d{2,})/i);
  const outputMatch = output.match(/\b(?:output|output_tokens)\s*:\s*(\d{2,})|(?:output)\s+(?:tokens?)\s*:\s*(\d{2,})/i);

  if (inputMatch && outputMatch) {
    // Extract token counts (may be in capture group 1 or 2)
    const inputTokens = Number.parseInt(inputMatch[1] || inputMatch[2], 10);
    const outputTokens = Number.parseInt(outputMatch[1] || outputMatch[2], 10);

    // Sanity check: reject if tokens seem unreasonably large (> 1M each)
    if (inputTokens > 1_000_000 || outputTokens > 1_000_000) {
      return null;
    }

    return {
      inputTokens,
      outputTokens,
    };
  }

  return null;
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
