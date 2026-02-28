/**
 * Auto-detection for contextFiles when PRD omits them (BUG-006)
 *
 * Extracts keywords from story title, runs git grep to find matching source files,
 * excludes test/index/generated files, caps at maxFiles.
 */

import { getLogger } from "../logger";

export interface AutoDetectOptions {
  /** Working directory for git grep */
  workdir: string;
  /** Story title to extract keywords from */
  storyTitle: string;
  /** Maximum files to return (default: 5) */
  maxFiles?: number;
  /** Enable import tracing (default: false, reserved for future use) */
  traceImports?: boolean;
}

/**
 * Extract keywords from story title for git grep search.
 *
 * Heuristics:
 * - Remove common words (the, a, an, and, or, to, from, for, with, etc.)
 * - Split on spaces/punctuation
 * - Keep words >= 3 chars
 * - Lowercase for case-insensitive matching
 *
 * @example
 * extractKeywords("BUG-006: Context auto-detection (contextFiles)")
 * // => ["bug", "006", "context", "auto", "detection", "contextfiles"]
 */
export function extractKeywords(title: string): string[] {
  const stopWords = new Set([
    "the",
    "a",
    "an",
    "and",
    "or",
    "to",
    "from",
    "for",
    "with",
    "in",
    "on",
    "at",
    "by",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "being",
    "have",
    "has",
    "had",
    "do",
    "does",
    "did",
    "will",
    "would",
    "should",
    "could",
    "may",
    "might",
    "can",
    "must",
    "of",
    "as",
    "if",
    "when",
    "bug",
    "fix",
    "add",
    "update",
    "remove",
    "implement",
  ]);

  // Split on non-alphanumeric, filter, lowercase
  const words = title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !stopWords.has(w));

  // Deduplicate
  return Array.from(new Set(words));
}

/**
 * Auto-detect context files via git grep when PRD omits contextFiles.
 *
 * Algorithm:
 * 1. Extract keywords from story title
 * 2. Run git grep for each keyword in src/ directories
 * 3. Deduplicate files
 * 4. Exclude test/index/generated files
 * 5. Cap at maxFiles (default: 5)
 *
 * Returns empty array if:
 * - Not a git repository
 * - No keywords extracted
 * - git grep fails
 * - No matching files found
 *
 * @param options - Auto-detect configuration
 * @returns Array of relative file paths (sorted by relevance score)
 */
export async function autoDetectContextFiles(options: AutoDetectOptions): Promise<string[]> {
  const { workdir, storyTitle, maxFiles = 5 } = options;
  const logger = getLogger();

  // Extract keywords
  const keywords = extractKeywords(storyTitle);
  if (keywords.length === 0) {
    logger.debug("auto-detect", "No keywords extracted from story title", { storyTitle });
    return [];
  }

  logger.debug("auto-detect", "Extracted keywords", { keywords, storyTitle });

  // Build git grep command
  // Use -i for case-insensitive, -l for filename-only, -I to skip binary files
  // Search in src/ directories only (exclude test, node_modules, etc.)
  const grepPattern = keywords.join("|"); // OR pattern
  const grepCommand = [
    "git",
    "grep",
    "-i", // case-insensitive
    "-l", // files-with-matches
    "-I", // skip binary files
    "-E", // extended regex
    "-e",
    grepPattern,
    "--", // separator
    "src/", // limit to src directory
  ];

  try {
    const proc = Bun.spawn(grepCommand, {
      cwd: workdir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    // git grep returns 1 when no matches found (not an error)
    if (exitCode !== 0 && exitCode !== 1) {
      const stderr = await new Response(proc.stderr).text();
      logger.warn("auto-detect", "git grep failed", { exitCode, stderr: stderr.trim() });
      return [];
    }

    if (!stdout.trim()) {
      logger.debug("auto-detect", "No files matched keywords", { keywords });
      return [];
    }

    // Parse file list
    const allFiles = stdout
      .trim()
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    // Filter out test files, index files, generated files
    const filtered = allFiles.filter((filePath) => {
      const lower = filePath.toLowerCase();
      // Exclude test files
      if (lower.includes(".test.") || lower.includes(".spec.") || lower.includes("/test/")) {
        return false;
      }
      // Exclude index files (barrel exports, low signal)
      if (lower.endsWith("/index.ts") || lower.endsWith("/index.js")) {
        return false;
      }
      // Exclude generated files
      if (lower.includes(".generated.") || lower.includes("/__generated__/")) {
        return false;
      }
      return true;
    });

    // Score and sort by relevance
    // Simple heuristic: count keyword matches in file path
    interface ScoredFile {
      path: string;
      score: number;
    }

    const scored: ScoredFile[] = filtered.map((filePath) => {
      const lowerPath = filePath.toLowerCase();
      const score = keywords.filter((kw) => lowerPath.includes(kw)).length;
      return { path: filePath, score };
    });

    // Sort by score descending, then alphabetically
    scored.sort((a, b) => {
      if (a.score !== b.score) {
        return b.score - a.score; // Higher score first
      }
      return a.path.localeCompare(b.path); // Alphabetical tiebreaker
    });

    // Cap at maxFiles
    const selected = scored.slice(0, maxFiles).map((s) => s.path);

    logger.info("auto-detect", "Auto-detected context files", {
      keywords,
      totalMatches: allFiles.length,
      afterFilter: filtered.length,
      selected: selected.length,
      files: selected,
    });

    return selected;
  } catch (error) {
    logger.warn("auto-detect", "Auto-detection failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}
