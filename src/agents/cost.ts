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

/** Cost estimate with confidence indicator */
export interface CostEstimate {
  cost: number;
  confidence: 'exact' | 'estimated' | 'fallback';
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
 * Token usage with confidence indicator.
 */
export interface TokenUsageWithConfidence {
  inputTokens: number;
  outputTokens: number;
  confidence: 'exact' | 'estimated';
}

/**
 * Parse Claude Code output for token usage.
 * Supports multiple formats:
 * - JSON: {"usage": {"input_tokens": 1234, "output_tokens": 5678}} → exact
 * - Markdown: "Input tokens: 1234" / "Output tokens: 5678" → estimated
 * - Plain: "input: 1234, output: 5678" → estimated
 *
 * Uses specific regex patterns to reduce false positives (BUG-3).
 */
export function parseTokenUsage(output: string): TokenUsageWithConfidence | null {
  // Try JSON format first (most reliable) - confidence: exact
  try {
    const jsonMatch = output.match(/\{[^}]*"usage"\s*:\s*\{[^}]*"input_tokens"\s*:\s*(\d+)[^}]*"output_tokens"\s*:\s*(\d+)[^}]*\}[^}]*\}/);
    if (jsonMatch) {
      return {
        inputTokens: Number.parseInt(jsonMatch[1], 10),
        outputTokens: Number.parseInt(jsonMatch[2], 10),
        confidence: 'exact',
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
              confidence: 'exact',
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
  // confidence: estimated (regex-based)
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
      confidence: 'estimated',
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
 * Returns cost estimate with confidence indicator:
 * - 'exact': Parsed from structured JSON output
 * - 'estimated': Extracted via regex patterns
 * Returns null if tokens cannot be parsed.
 */
export function estimateCostFromOutput(
  modelTier: ModelTier,
  output: string,
): CostEstimate | null {
  const usage = parseTokenUsage(output);
  if (!usage) {
    return null;
  }
  const cost = estimateCost(modelTier, usage.inputTokens, usage.outputTokens);
  return {
    cost,
    confidence: usage.confidence,
  };
}

/**
 * Fallback cost estimation based on runtime duration.
 * Used when token usage cannot be parsed from output.
 *
 * Rough estimates per minute of agent runtime:
 * - fast (Haiku): ~$0.01/min
 * - balanced (Sonnet): ~$0.05/min
 * - powerful (Opus): ~$0.15/min
 *
 * Returns cost estimate with 'fallback' confidence.
 */
export function estimateCostByDuration(
  modelTier: ModelTier,
  durationMs: number,
): CostEstimate {
  const costPerMinute: Record<ModelTier, number> = {
    fast: 0.01,
    balanced: 0.05,
    powerful: 0.15,
  };
  const minutes = durationMs / 60000;
  const cost = minutes * costPerMinute[modelTier];
  return {
    cost,
    confidence: 'fallback',
  };
}

/**
 * Format cost estimate with confidence indicator.
 * Examples:
 * - exact: "$0.12"
 * - estimated: "~$0.15"
 * - fallback: "~$0.05 (duration-based)"
 */
export function formatCostWithConfidence(estimate: CostEstimate): string {
  const formattedCost = `$${estimate.cost.toFixed(2)}`;

  switch (estimate.confidence) {
    case 'exact':
      return formattedCost;
    case 'estimated':
      return `~${formattedCost}`;
    case 'fallback':
      return `~${formattedCost} (duration-based)`;
  }
}
