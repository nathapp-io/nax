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
  if (!response?.trim()) {
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
 * True when the agent's refinement output is unusable and the op should reject
 * it — i.e. empty/whitespace response, output that fails JSON extraction/parse,
 * a non-array result, or a non-empty array in which any item lacks a usable
 * `refined` string (strings, numbers and nulls carry none).
 * An empty array `[]` is a *successful* parse (returns `[]`), so it is NOT
 * rejected here — the count check in the acceptance-refine op catches it.
 *
 * This is deliberately a SUPERSET of `parseRefinementResponse`'s fallback cases
 * above: the parser silently substitutes the unrefined criterion for an item
 * that lacks a usable `refined` string (e.g. `[1,2,3]` maps item-by-item and
 * returns an array), so it does not fall back there. This predicate lives beside
 * the parser to be read together, but it does NOT mirror the parser's triggers —
 * it is the stricter "the agent produced nothing worth keeping" test the op
 * needs. Used by the acceptance-refine op (#3B) to reject non-empty output it
 * cannot use. Note: empty/whitespace output is handled upstream by the op's
 * parse() — it throws ParseValidationError to trigger a retry rather than
 * falling back immediately.
 */
export function refinementWouldFallback(response: string): boolean {
  if (!response?.trim()) return true;
  try {
    const fromFence = extractJsonFromMarkdown(response);
    const cleaned = stripTrailingCommas(fromFence !== response ? fromFence : response);
    const parsed = recoverJsonArray(cleaned) ?? JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return true;
    return parsed.length > 0 && !parsed.every(isRefinementItem);
  } catch {
    return true;
  }
}

/**
 * True when a parsed array item carries a refinement the parser can actually
 * use. `parseRefinementResponse` substitutes the unrefined criterion for any
 * item without a non-empty `refined` string — and throws, falling back for the
 * whole array, when an item is not an object at all — so such an item is not
 * evidence that the agent produced output worth keeping.
 */
function isRefinementItem(item: unknown): boolean {
  if (typeof item !== "object" || item === null) return false;
  const refined = (item as { refined?: unknown }).refined;
  return typeof refined === "string" && refined.length > 0;
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
