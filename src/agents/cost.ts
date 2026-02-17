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
 *
 * Supports multiple formats with varying confidence levels:
 * - JSON structured output → "exact" confidence
 * - Markdown/plain text patterns → "estimated" confidence
 *
 * Uses specific regex patterns to reduce false positives.
 *
 * @param output - Agent stdout + stderr combined
 * @returns Token usage with confidence indicator, or null if tokens cannot be parsed
 *
 * @example
 * ```ts
 * // JSON format (exact)
 * const usage1 = parseTokenUsage('{"usage": {"input_tokens": 1234, "output_tokens": 5678}}');
 * // { inputTokens: 1234, outputTokens: 5678, confidence: 'exact' }
 *
 * // Markdown format (estimated)
 * const usage2 = parseTokenUsage('Input tokens: 1234\nOutput tokens: 5678');
 * // { inputTokens: 1234, outputTokens: 5678, confidence: 'estimated' }
 *
 * // Unparseable
 * const usage3 = parseTokenUsage('No token data here');
 * // null
 * ```
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
 *
 * Calculates total cost using tier-specific rates per 1M tokens.
 *
 * @param modelTier - Model tier (fast/balanced/powerful)
 * @param inputTokens - Number of input tokens consumed
 * @param outputTokens - Number of output tokens generated
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
): number {
  const rates = COST_RATES[modelTier];
  const inputCost = (inputTokens / 1_000_000) * rates.inputPer1M;
  const outputCost = (outputTokens / 1_000_000) * rates.outputPer1M;
  return inputCost + outputCost;
}

/**
 * Estimate cost from agent output by parsing token usage.
 *
 * Attempts to extract token counts from stdout/stderr, then calculates cost.
 * Returns null if tokens cannot be parsed (caller should use fallback estimation).
 *
 * @param modelTier - Model tier for cost calculation
 * @param output - Agent stdout + stderr combined
 * @returns Cost estimate with confidence indicator, or null if unparseable
 *
 * @example
 * ```ts
 * const estimate = estimateCostFromOutput("balanced", agentOutput);
 * if (estimate) {
 *   console.log(`Cost: $${estimate.cost.toFixed(4)} (${estimate.confidence})`);
 * } else {
 *   // Fall back to duration-based estimation
 * }
 * ```
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
    case 'exact':
      return formattedCost;
    case 'estimated':
      return `~${formattedCost}`;
    case 'fallback':
      return `~${formattedCost} (duration-based)`;
  }
}
