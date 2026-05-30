/**
 * AC Refinement Module
 *
 * Takes raw PRD acceptanceCriteria strings and refines them into concrete,
 * testable assertions using an LLM call via adapter.complete().
 */

import { extractJsonFromMarkdown, stripTrailingCommas } from "../utils/llm-json";
import type { RefinedCriterion } from "./types";

/**
 * Parse the LLM JSON response into RefinedCriterion[].
 *
 * Falls back gracefully: if JSON is malformed or a criterion is missing,
 * uses the original text with testable: true.
 *
 * @param response - Raw LLM response text
 * @param criteria - Original criteria strings (used as fallback)
 * @returns Array of refined criteria
 */
export function parseRefinementResponse(response: string, criteria: string[]): RefinedCriterion[] {
  if (!response || !response.trim()) {
    return fallbackCriteria(criteria);
  }

  try {
    const fromFence = extractJsonFromMarkdown(response);
    const cleaned = stripTrailingCommas(fromFence !== response ? fromFence : response);
    const parsed: unknown = JSON.parse(cleaned);

    if (!Array.isArray(parsed)) {
      return fallbackCriteria(criteria);
    }

    return (parsed as RefinedCriterion[]).map((item, i) => ({
      original: typeof item.original === "string" && item.original.length > 0 ? item.original : (criteria[i] ?? ""),
      refined: typeof item.refined === "string" && item.refined.length > 0 ? item.refined : (criteria[i] ?? ""),
      testable: typeof item.testable === "boolean" ? item.testable : true,
      storyId: typeof item.storyId === "string" ? item.storyId : "",
    }));
  } catch {
    return fallbackCriteria(criteria);
  }
}

/**
 * True when `parseRefinementResponse` would discard the agent's output and fall
 * back to the unrefined criteria — i.e. empty/whitespace response, output that
 * fails JSON extraction/parse, or a non-array result. An empty array `[]` is a
 * *successful* parse (returns `[]`), so it is NOT a fallback.
 *
 * Mirrors the fallback triggers in `parseRefinementResponse` above and lives
 * beside it so the two stay in sync. Used by the acceptance-refine op (#3B) to
 * log an accurate degradation warning — the log must only claim "fell back to
 * unrefined criteria" when that is what actually happened.
 */
export function refinementWouldFallback(response: string): boolean {
  if (!response || !response.trim()) return true;
  try {
    const fromFence = extractJsonFromMarkdown(response);
    const cleaned = stripTrailingCommas(fromFence !== response ? fromFence : response);
    return !Array.isArray(JSON.parse(cleaned));
  } catch {
    return true;
  }
}

/**
 * Build fallback RefinedCriterion[] using original criterion text.
 */
function fallbackCriteria(criteria: string[], storyId = ""): RefinedCriterion[] {
  return criteria.map((c) => ({
    original: c,
    refined: c,
    testable: true,
    storyId,
  }));
}
