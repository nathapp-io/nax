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
    const parsed: unknown = recoverJsonArray(cleaned) ?? JSON.parse(cleaned);

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
 * log an accurate degradation warning for non-empty unparseable output. Note:
 * empty/whitespace output is handled upstream by the op's parse() — it throws
 * ParseValidationError to trigger a retry rather than falling back immediately.
 */
export function refinementWouldFallback(response: string): boolean {
  if (!response || !response.trim()) return true;
  try {
    const fromFence = extractJsonFromMarkdown(response);
    const cleaned = stripTrailingCommas(fromFence !== response ? fromFence : response);
    const parsed = recoverJsonArray(cleaned) ?? JSON.parse(cleaned);
    return !Array.isArray(parsed);
  } catch {
    return true;
  }
}

/**
 * Recovers a JSON array that was truncated before its closing `]` — the
 * pattern produced when an LLM hits its output-token limit mid-generation.
 *
 * Strategy 1: append `]` directly (handles the common case where the last
 *             complete item ends with `}`).
 * Strategy 2: truncate to the last complete `}` then append `]` (handles
 *             the rarer case where truncation happened inside the last item).
 *
 * Returns the parsed array on success, or null if recovery is not applicable
 * (response is already valid, does not start with `[`, or cannot be repaired).
 */
function recoverJsonArray(text: string): unknown[] | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("[") || trimmed.endsWith("]")) return null;

  // Strategy 1: simple close
  try {
    const closed = stripTrailingCommas(`${trimmed}]`);
    const parsed = JSON.parse(closed);
    if (Array.isArray(parsed)) return parsed as unknown[];
  } catch {
    /* fall through to strategy 2 */
  }

  // Strategy 2: truncate to the last complete item boundary then close
  const lastBrace = trimmed.lastIndexOf("}");
  if (lastBrace === -1) return null;
  try {
    const recovered = `${stripTrailingCommas(trimmed.slice(0, lastBrace + 1))}]`;
    const parsed = JSON.parse(recovered);
    if (Array.isArray(parsed)) return parsed as unknown[];
  } catch {
    /* unrecoverable */
  }

  return null;
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
