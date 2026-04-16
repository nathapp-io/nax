/**
 * Feature Context Filter — role-based audience filtering for context.md entries.
 *
 * Each entry in context.md carries an inline audience tag at the end of its
 * headline: `[implementer]`, `[all]`, `[test-writer, implementer]`, etc.
 * This module parses those tags and filters entries for the current role.
 */
import { getLogger } from "../logger";
import type { PromptRole } from "../prompts/core/types";

/** Audience tags recognized in context.md entries */
type AudienceTag =
  | "all"
  | "implementer"
  | "test-writer"
  | "verifier"
  | "reviewer"
  | "reviewer-semantic"
  | "reviewer-adversarial";

/**
 * Map from PromptRole to the set of audience tags that role should receive.
 * Entries tagged [all] are always included regardless of role.
 * Roles introduced in v2 (rectifier, autofixer, planner, etc.) are not listed
 * here — they fall through to direct tag matching (the role string is compared
 * against audience tags literally, and [all] is always included).
 */
const ROLE_AUDIENCE_MAP: Record<PromptRole, AudienceTag[]> = {
  implementer: ["all", "implementer"],
  "test-writer": ["all", "test-writer"],
  verifier: ["all", "verifier"],
  "single-session": ["all", "implementer", "test-writer"],
  "tdd-simple": ["all", "implementer", "test-writer"],
  "no-test": ["all", "implementer"],
  batch: ["all", "implementer", "test-writer"],
};

/** Reviewer role → tags map */
const REVIEWER_AUDIENCE_MAP: Record<string, AudienceTag[]> = {
  "reviewer-semantic": ["all", "reviewer", "reviewer-semantic"],
  "reviewer-adversarial": ["all", "reviewer", "reviewer-adversarial"],
  reviewer: ["all", "reviewer", "reviewer-semantic", "reviewer-adversarial"],
};

/**
 * Parse audience tags from an entry headline.
 * Returns the tags as lowercase strings.
 * If no tag is found, returns ["all"] (backward-compatible default).
 *
 * Matches `[tag]` or `[tag1, tag2]` at the END of the line, after the heading text.
 * Case-insensitive. The tag block is the LAST `[...]` on the line.
 */
export function parseAudienceTags(headline: string): string[] {
  // Match the last occurrence of [...] on the headline
  const matches = [...headline.matchAll(/\[([^\]]+)\]/g)];
  if (matches.length === 0) return ["all"];

  const lastMatch = matches[matches.length - 1];
  const tagStr = lastMatch[1];
  return tagStr
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Determine if an entry (identified by its audience tags) should be included
 * for the given role.
 */
export function shouldIncludeEntry(tags: string[], role: PromptRole | string): boolean {
  // Get the allowed tags for this role
  const allowedTags: string[] = ROLE_AUDIENCE_MAP[role as PromptRole] ?? REVIEWER_AUDIENCE_MAP[role] ?? ["all", role]; // v2 roles: always include [all] + direct match

  // Include if any of the entry's tags appear in the allowed set
  return tags.some((tag) => allowedTags.includes(tag));
}

/**
 * Filter context.md entries by audience tag for the current role.
 * Parses the Markdown, keeps entries whose audience matches the role.
 * Entries without a tag default to [all] (backward-compatible).
 * Empty sections are removed.
 */
export function filterContextByRole(contextMd: string, role: PromptRole | string): string {
  if (!contextMd.trim()) return "";

  const lines = contextMd.split("\n");
  const outputSections: string[] = [];

  let currentSectionHeader = "";
  let currentSectionLines: string[] = [];
  let inEntry = false;
  let entryLines: string[] = [];
  let entryIncluded = false;
  let pendingEntries: string[] = [];

  function flushEntry() {
    if (entryLines.length === 0) return;
    if (entryIncluded) {
      pendingEntries.push(...entryLines);
    }
    entryLines = [];
    inEntry = false;
    entryIncluded = false;
  }

  function flushSection() {
    flushEntry();
    if (pendingEntries.length > 0) {
      const section = currentSectionHeader
        ? [currentSectionHeader, "", ...pendingEntries].join("\n")
        : pendingEntries.join("\n");
      outputSections.push(section);
    } else if (currentSectionLines.length > 0 && !currentSectionHeader.startsWith("##")) {
      // Non-section content (e.g., title, metadata line) — always keep
      outputSections.push(currentSectionLines.join("\n"));
    }
    currentSectionLines = [];
    pendingEntries = [];
  }

  for (const line of lines) {
    // Top-level heading (# ...) — not a section, always keep
    if (line.startsWith("# ")) {
      flushSection();
      currentSectionHeader = "";
      currentSectionLines = [line];
      continue;
    }

    // Metadata / italic lines directly under title (e.g., _Last updated: ..._)
    if (!currentSectionHeader && line.startsWith("_") && line.endsWith("_")) {
      currentSectionLines.push(line);
      continue;
    }

    // Empty line between sections or between entries — buffered
    if (line.trim() === "") {
      if (inEntry) {
        // Empty line might continue the entry (indented body follows) or end it
        // We'll handle it by checking next line — for now, buffer in entryLines
        entryLines.push(line);
      }
      continue;
    }

    // Section heading (## ...) — flush previous section, start new one
    if (line.startsWith("## ")) {
      flushSection();
      currentSectionHeader = line;
      continue;
    }

    // Entry start: a bullet beginning with "- **"
    if (line.startsWith("- **") || line.startsWith("- ")) {
      // Flush any previous entry first
      flushEntry();

      inEntry = true;
      entryLines = [line];

      // Determine audience from headline
      const tags = parseAudienceTags(line);
      entryIncluded = shouldIncludeEntry(tags, role);
      continue;
    }

    // Entry body (continuation — indented or narrative line after bullet)
    if (inEntry) {
      entryLines.push(line);
      continue;
    }

    // Anything else in a section (non-entry text)
    if (currentSectionHeader) {
      currentSectionLines.push(line);
    } else {
      currentSectionLines.push(line);
    }
  }

  // Flush final section
  flushSection();

  return outputSections.join("\n\n").trim();
}

/**
 * Estimate token count for a string (rough: 1 token ≈ 4 chars).
 * Used for budget enforcement only — not for billing.
 */
export function estimateContextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Truncate context to fit within budgetTokens.
 * Tail-biased: keeps the most recent entries (bottom of file).
 * Logs a warning when truncation is applied.
 */
export function truncateToContextBudget(filteredMd: string, budgetTokens: number, featureId: string): string {
  const logger = getLogger();
  const estimated = estimateContextTokens(filteredMd);

  if (estimated <= budgetTokens) return filteredMd;

  logger.warn("feature-context", "Feature context exceeds budget, truncating (tail-biased)", {
    featureId,
    estimatedTokens: estimated,
    budgetTokens,
  });

  // Tail-biased: keep as many chars from the END as the budget allows
  const maxChars = budgetTokens * 4;
  const truncated = filteredMd.slice(filteredMd.length - maxChars);

  // Trim to a clean line boundary to avoid splitting mid-entry
  const newlineIdx = truncated.indexOf("\n");
  return newlineIdx > 0 ? truncated.slice(newlineIdx + 1) : truncated;
}
