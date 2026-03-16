/**
 * Token usage parsing from raw agent output strings.
 */

import type { TokenUsageWithConfidence } from "./types";

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
    const jsonMatch = output.match(
      /\{[^}]*"usage"\s*:\s*\{[^}]*"input_tokens"\s*:\s*(\d+)[^}]*"output_tokens"\s*:\s*(\d+)[^}]*\}[^}]*\}/,
    );
    if (jsonMatch) {
      return {
        inputTokens: Number.parseInt(jsonMatch[1], 10),
        outputTokens: Number.parseInt(jsonMatch[2], 10),
        confidence: "exact",
      };
    }

    // Try parsing as full JSON object
    const lines = output.split("\n");
    for (const line of lines) {
      if (line.trim().startsWith("{")) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.usage?.input_tokens && parsed.usage?.output_tokens) {
            return {
              inputTokens: parsed.usage.input_tokens,
              outputTokens: parsed.usage.output_tokens,
              confidence: "exact",
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
  const outputMatch = output.match(
    /\b(?:output|output_tokens)\s*:\s*(\d{2,})|(?:output)\s+(?:tokens?)\s*:\s*(\d{2,})/i,
  );

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
      confidence: "estimated",
    };
  }

  return null;
}
