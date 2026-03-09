/**
 * Overlap validator.
 *
 * Checks keyword + tag similarity between each substory and all existing PRD stories.
 * Uses Jaccard-like normalized keyword intersection over title + tags.
 * Flags pairs with similarity > 0.6 as warnings, > 0.8 as errors.
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

function extractKeywords(texts: string[]): Set<string> {
  const words = texts
    .join(" ")
    .toLowerCase()
    .split(/[\s,.:;!?()\[\]{}"'`\-_/\\]+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w) && !/^\d+$/.test(w));
  return new Set(words);
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersectionSize = 0;
  for (const word of a) {
    if (b.has(word)) intersectionSize++;
  }
  const unionSize = a.size + b.size - intersectionSize;
  return unionSize === 0 ? 0 : intersectionSize / unionSize;
}

// Use title + tags only for overlap detection to get stable, meaningful similarity scores
function substoryKeywords(s: SubStory): Set<string> {
  return extractKeywords([s.title, ...s.tags]);
}

function storyKeywords(s: UserStory): Set<string> {
  return extractKeywords([s.title, ...(s.tags ?? [])]);
}

export function validateOverlap(substories: SubStory[], existingStories: UserStory[]): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const sub of substories) {
    const subKw = substoryKeywords(sub);
    for (const existing of existingStories) {
      const exKw = storyKeywords(existing);
      const sim = jaccardSimilarity(subKw, exKw);
      if (sim > 0.8) {
        errors.push(
          `Substory ${sub.id} overlaps with existing story ${existing.id} (similarity ${sim.toFixed(2)} > 0.8)`,
        );
      } else if (sim > 0.6) {
        warnings.push(
          `Substory ${sub.id} may overlap with existing story ${existing.id} (similarity ${sim.toFixed(2)} > 0.6)`,
        );
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}
