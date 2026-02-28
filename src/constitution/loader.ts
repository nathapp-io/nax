/**
 * Constitution loader
 *
 * Loads and processes global + project constitution files.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { validateFilePath } from "../config/path-security";
import { globalConfigDir } from "../config/paths";
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
 * Load constitution from global and project directories.
 *
 * Prepends global constitution to project constitution with --- separator.
 * Respects skipGlobal flag in config.
 *
 * @param projectDir - Path to project nax/ directory
 * @param config - Constitution configuration
 * @returns Constitution result or null if disabled/missing
 */
export async function loadConstitution(
  projectDir: string,
  config: ConstitutionConfig,
): Promise<ConstitutionResult | null> {
  if (!config.enabled) {
    return null;
  }

  let combinedContent = "";

  // Load global constitution (unless skipGlobal is true)
  if (!config.skipGlobal) {
    const globalPath = join(globalConfigDir(), config.path);
    if (existsSync(globalPath)) {
      // SEC-5: Validate path before reading
      const validatedPath = validateFilePath(globalPath, globalConfigDir());
      const globalFile = Bun.file(validatedPath);
      const globalContent = await globalFile.text();
      if (globalContent.trim()) {
        combinedContent = globalContent.trim();
      }
    }
  }

  // Load project constitution
  const projectPath = join(projectDir, config.path);
  if (existsSync(projectPath)) {
    // SEC-5: Validate path before reading
    const validatedPath = validateFilePath(projectPath, projectDir);
    const projectFile = Bun.file(validatedPath);
    const projectContent = await projectFile.text();
    if (projectContent.trim()) {
      // Concatenate with separator if both exist
      if (combinedContent) {
        combinedContent += `\n\n---\n\n${projectContent.trim()}`;
      } else {
        // If no global content, preserve exact project content (including trailing newline)
        combinedContent = projectContent;
      }
    }
  }

  // Return null if no content loaded
  if (!combinedContent) {
    return null;
  }

  const tokens = estimateTokens(combinedContent);

  if (tokens <= config.maxTokens) {
    return {
      content: combinedContent,
      tokens,
      truncated: false,
    };
  }

  // Truncate to fit within maxTokens
  const truncatedContent = truncateToTokens(combinedContent, config.maxTokens);
  const truncatedTokens = estimateTokens(truncatedContent);

  return {
    content: truncatedContent,
    tokens: truncatedTokens,
    truncated: true,
    originalTokens: tokens,
  };
}
