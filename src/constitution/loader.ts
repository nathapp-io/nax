/**
 * Constitution loader
 *
 * Loads and processes the project constitution file.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ConstitutionConfig, ConstitutionResult } from "./types";

/**
 * Estimate token count for text
 *
 * Uses simple heuristic: 1 token ≈ 3 characters (conservative estimate)
 * This is a rough approximation sufficient for quota management.
 *
 * @param text - Text to estimate tokens for
 * @returns Estimated token count
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

/**
 * Truncate text to fit within token limit
 *
 * Truncates at word boundaries to avoid cutting mid-word.
 *
 * @param text - Text to truncate
 * @param maxTokens - Maximum tokens allowed
 * @returns Truncated text
 */
export function truncateToTokens(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 3; // 1 token ≈ 3 chars

  if (text.length <= maxChars) {
    return text;
  }

  // Find last word boundary before maxChars
  const truncated = text.slice(0, maxChars);
  const lastSpace = truncated.lastIndexOf(" ");
  const lastNewline = truncated.lastIndexOf("\n");
  const cutPoint = Math.max(lastSpace, lastNewline);

  if (cutPoint > 0) {
    return truncated.slice(0, cutPoint);
  }

  // Fallback: hard cut if no word boundary found
  return truncated;
}

/**
 * Load constitution from project directory
 *
 * Reads the constitution file, estimates token count, and truncates if needed.
 * Returns null if constitution is disabled or file doesn't exist.
 *
 * @param ngentDir - Path to ngent/ directory
 * @param config - Constitution configuration
 * @returns Constitution result or null if disabled/missing
 */
export async function loadConstitution(
  ngentDir: string,
  config: ConstitutionConfig,
): Promise<ConstitutionResult | null> {
  if (!config.enabled) {
    return null;
  }

  const constitutionPath = join(ngentDir, config.path);

  if (!existsSync(constitutionPath)) {
    return null;
  }

  const file = Bun.file(constitutionPath);
  const content = await file.text();

  if (!content.trim()) {
    return null;
  }

  const tokens = estimateTokens(content);

  if (tokens <= config.maxTokens) {
    return {
      content,
      tokens,
      truncated: false,
    };
  }

  // Truncate to fit within maxTokens
  const truncatedContent = truncateToTokens(content, config.maxTokens);
  const truncatedTokens = estimateTokens(truncatedContent);

  return {
    content: truncatedContent,
    tokens: truncatedTokens,
    truncated: true,
    originalTokens: tokens,
  };
}
