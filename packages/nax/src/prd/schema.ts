/**
 * PRD JSON Validation and Schema Enforcement
 *
 * Validates and normalizes LLM-generated PRD JSON output before writing to disk.
 */

import { NaxError } from "../errors";
import {
  escapeRawControlChars,
  extractJsonFromMarkdown,
  extractJsonObject,
  stripTrailingCommas,
} from "../utils/llm-json";
import { assertNoDependencyCycle } from "./dependency-cycle";
import { normalizeOutOfScopeList } from "./out-of-scope";
import { normalizeStoryId, validateStory } from "./schema-story";
import type { PRD, UserStory } from "./types";

export { extractJsonFromMarkdown };

/**
 * Remove invalid escape sequences that LLMs commonly generate.
 *
 * JSON.parse only accepts:
 *   \"  \\  \/  \b  \f  \n  \r  \t  \uXXXX
 *
 * LLMs often produce:
 *   \xNN  → should be \u00NN
 *   \xN   → should be \u000N
 *   \x    → invalid, strip the backslash
 *   \uXXX → missing one digit, pad to \u0XXX
 *   \uXX  → missing two digits, pad to \u00XX
 *   \uX   → missing three digits, pad to \u000X
 *   \u    → no digits, strip the backslash
 *   \N    → any other backslash + non-special char, strip backslash
 */
function sanitizeInvalidEscapes(text: string): string {
  // \xNN or \xN: convert to \u00NN / \u000N
  // The first replace catches \x followed by 1–2 hex digits (possibly with non-hex following).
  // e.g. "\xAg" (invalid hex "g") → "\u00Ag" (still invalid but closer; JSON.parse throws)
  // e.g. "\xAxyz" → "\u000Axyz"
  let result = text.replace(/\\x([0-9a-fA-F]{1,2})/g, (_, hex) => `\\u00${hex.padStart(2, "0")}`);

  // \uXXXX (4 hex digits): valid, keep as-is
  // \uXXX / \uXX / \uX: pad with leading zeros when followed by non-hex or end-of-string
  result = result.replace(/\\u([0-9a-fA-F]{1,3})(?![0-9a-fA-F])/g, (_, digits) => `\\u${digits.padStart(4, "0")}`);
  result = result.replace(/\\u(?![0-9a-fA-F])/g, "\\");

  // Remove backslash before any character that is NOT a valid JSON escape char.
  // Valid: " \ / b f n r t u
  // Match valid \\ pairs first (to preserve them), then strip lone \ before invalid char.
  // Without the pair-first branch, \\( would corrupt to \( (invalid), because the regex
  // would match the second \ + ( after skipping the first \ + \ (which IS in the exclusion).
  result = result.replace(/(\\\\)|\\([^"\\/bfnrtu])/g, (_, pair, bad) => pair ?? bad);

  return result;
}

/**
 * Parse raw string input, handling markdown wrapping, trailing commas,
 * and common LLM-generated invalid escape sequences.
 * Throws with parse error context on failure.
 */
function parseRawString(text: string): unknown {
  // Pass 1: strip markdown code fence if present
  let extracted = extractJsonFromMarkdown(text);

  // Pass 2: if no fence was found (returned unchanged), try extracting the bare JSON
  // object/array by scanning for the first { or [ and last matching } or ].
  // This handles LLM output that wraps JSON in single backticks, adds preamble/postamble
  // text, or omits code fences entirely.
  if (extracted === text) {
    const bare = extractJsonObject(text);
    if (bare) extracted = bare;
  }

  const cleaned = stripTrailingCommas(extracted);
  const sanitized = sanitizeInvalidEscapes(cleaned);

  try {
    return JSON.parse(sanitized);
  } catch (err) {
    // Second attempt: a control character sitting literally inside a string —
    // a real newline in `analysis` is the observed case (#2124) — makes the
    // whole payload unparseable even when nothing else is wrong. The repair is
    // a no-op on valid JSON, so it only ever runs here, and a payload broken
    // for any other reason still reports the ORIGINAL parse error.
    const repaired = escapeRawControlChars(sanitized);
    if (repaired !== sanitized) {
      try {
        return JSON.parse(repaired);
      } catch {
        /* control characters were not the only defect — fall through */
      }
    }

    const parseErr = err as SyntaxError;
    throw new NaxError(`[schema] Failed to parse JSON: ${parseErr.message}`, "SCHEMA_VALIDATION_FAILED", {
      stage: "schema",
      cause: parseErr,
    });
  }
}

/**
 * Validate and normalize the JSON output from the planning LLM.
 *
 * @param raw - Raw LLM output (string or already-parsed object)
 * @param feature - Feature name for auto-fill
 * @param branch - Branch name for auto-fill
 * @returns Validated PRD object
 */
export function validatePlanOutput(raw: unknown, feature: string, branch: string): PRD {
  // Parse string input
  const parsed: unknown = typeof raw === "string" ? parseRawString(raw) : raw;

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new NaxError("[schema] PRD output must be a JSON object", "SCHEMA_VALIDATION_FAILED", { stage: "schema" });
  }

  const obj = parsed as Record<string, unknown>;

  // Validate top-level userStories
  const rawStories = obj.userStories;
  if (!Array.isArray(rawStories) || rawStories.length === 0) {
    throw new NaxError("[schema] userStories is required and must be a non-empty array", "SCHEMA_VALIDATION_FAILED", {
      stage: "schema",
    });
  }

  // First pass: collect all story IDs (after normalization) for dependency validation
  const allIds = new Set<string>();
  for (const story of rawStories) {
    if (typeof story === "object" && story !== null && !Array.isArray(story)) {
      const s = story as Record<string, unknown>;
      const rawId = s.id;
      if (typeof rawId === "string" && rawId !== "") {
        allIds.add(normalizeStoryId(rawId));
      }
    }
  }

  // Second pass: full validation. seenIds accumulates across the pass to reject
  // a story whose own id duplicates an earlier story's id (allIds already
  // contains every id up front, so it cannot be used to detect duplicates).
  const seenIds = new Set<string>();
  const userStories: UserStory[] = rawStories.map((story, index) => validateStory(story, index, allIds, seenIds));

  // BUG-27: fail fast on a cycle instead of letting worktree/merge.ts discover it mid-run.
  assertNoDependencyCycle(userStories);

  const now = new Date().toISOString();
  const featureOutOfScope = normalizeOutOfScopeList(obj.outOfScope);

  return {
    project: typeof obj.project === "string" && obj.project !== "" ? obj.project : feature,
    feature,
    branchName: branch,
    createdAt: typeof obj.createdAt === "string" ? obj.createdAt : now,
    updatedAt: now,
    userStories,
    ...(typeof obj.analysis === "string" && obj.analysis.trim() !== "" ? { analysis: obj.analysis.trim() } : {}),
    ...(featureOutOfScope !== undefined ? { outOfScope: featureOutOfScope } : {}),
  };
}
