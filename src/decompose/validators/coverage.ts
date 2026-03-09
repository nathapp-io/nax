/**
 * Coverage validator.
 *
 * Checks that the union of substory acceptance criteria covers
 * the original story's AC using keyword matching.
 * Warns on unmatched original criteria.
 */

import type { UserStory } from "../../prd";
import type { SubStory, ValidationResult } from "../types";

const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
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
  "could",
  "should",
  "may",
  "might",
  "can",
  "to",
  "of",
  "in",
  "on",
  "at",
  "for",
  "with",
  "by",
  "from",
  "as",
  "it",
  "its",
  "that",
  "this",
  "these",
  "those",
  "not",
  "no",
  "so",
  "if",
  "then",
  "than",
  "when",
  "which",
  "who",
  "what",
  "how",
  "all",
  "each",
  "any",
  "up",
  "out",
  "about",
  "into",
  "through",
  "after",
  "before",
]);

function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s,.:;!?()\[\]{}"'`\-_/\\]+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

function commonPrefixLength(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/**
 * Two keywords match if they are identical or share a common prefix of ≥5 chars.
 * This handles morphological variants like "register" / "registration" (prefix "regist" = 6).
 * It does NOT match unrelated words that start with "re" ("reset" vs "register" = 2 chars).
 */
function keywordsMatch(a: string, b: string): boolean {
  return a === b || commonPrefixLength(a, b) >= 5;
}

/**
 * Returns true if the original AC is "covered" by the union of substory ACs.
 * Covered means: strictly more than half of the original AC's keywords have a
 * match (exact or common-prefix ≥5) in the substory AC keywords.
 */
function isCovered(originalAc: string, substoryAcs: string[]): boolean {
  const originalKw = extractKeywords(originalAc);
  if (originalKw.length === 0) return true;

  const substoryKwList = substoryAcs.flatMap(extractKeywords);

  let matchCount = 0;
  for (const kw of originalKw) {
    if (substoryKwList.some((s) => keywordsMatch(kw, s))) {
      matchCount++;
    }
  }

  // Require strictly more than half of the original AC's keywords to match
  return matchCount > originalKw.length / 2;
}

export function validateCoverage(originalStory: UserStory, substories: SubStory[]): ValidationResult {
  const warnings: string[] = [];

  const allSubstoryAcs = substories.flatMap((s) => s.acceptanceCriteria);

  for (const ac of originalStory.acceptanceCriteria ?? []) {
    if (!isCovered(ac, allSubstoryAcs)) {
      warnings.push(`Original AC not covered by any substory: "${ac}"`);
    }
  }

  return { valid: true, errors: [], warnings };
}
