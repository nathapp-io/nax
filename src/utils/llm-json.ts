/**
 * LLM JSON Extraction Utilities
 *
 * Shared utilities for extracting and cleaning JSON from LLM responses,
 * and for building prompts that request JSON output.
 *
 * LLMs frequently wrap JSON in markdown fences, add preamble/postamble text,
 * or include trailing commas — these utilities handle all common patterns.
 */

/**
 * Extract JSON from a markdown code block.
 *
 * Non-anchored — handles preamble text before the fence (common LLM behavior).
 *
 * Handles:
 *   ```json ... ```
 *   ``` ... ```
 *
 * Returns the input unchanged if no code block is detected.
 */
export function extractJsonFromMarkdown(text: string): string {
  const match = text.match(/```(?:json)?\s*\n([\s\S]*?)\n?\s*```/);
  if (match) {
    return match[1] ?? text;
  }
  return text;
}

/**
 * Strip trailing commas before closing braces/brackets.
 * e.g. `{"a":1,}` → `{"a":1}`
 *
 * Common LLM quirk especially in truncated or partial responses.
 *
 * Only *structural* commas are removed. The scan tracks JSON string literals
 * (honouring backslash escapes) and leaves their contents byte-for-byte
 * intact: a trailing comma is syntax, but the same characters inside a string
 * value are data — an acceptance criterion quoting `{a: 1,}`, a review finding
 * quoting an array literal. A plain `/,\s*([}\]])/g` replace cannot tell the
 * two apart, and because its rewrite still parses, the corruption is silent.
 *
 * Degenerate input: an odd number of unescaped quotes (truncated LLM output
 * with a stray quote) flips `inString` to true at the unbalanced position
 * and leaves it true through the rest of the input. The mask marks every
 * subsequent character as "inside a string", so structural trailing commas
 * after the unbalanced quote are *not* stripped. This is intentional —
 * leaving them in makes the output fail JSON.parse, and the caller falls
 * back to the next parseLLMJson tier. Optimising this case is out of scope;
 * a stray quote in LLM output already indicates truncation worth retrying.
 */
export function stripTrailingCommas(text: string): string {
  const insideString = markStringLiteralSpans(text);

  // The `\s*` between the comma and the closer cannot contain a quote, so a
  // structural-looking match can only be spurious if the COMMA itself sits
  // inside a string — one mask lookup is enough to decide.
  return text.replace(/,\s*([}\]])/g, (match, closer: string, offset: number) =>
    insideString[offset] ? match : closer,
  );
}

/**
 * One linear pass marking every index that falls inside a JSON string literal
 * (quotes themselves excluded), honouring backslash escapes.
 */
function markStringLiteralSpans(text: string): Uint8Array {
  const mask = new Uint8Array(text.length);
  let inString = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);

    if (inString) {
      if (ch === 0x5c /* \ */) {
        // Skip the escaped character so an escaped quote or an escaped
        // backslash cannot be mistaken for the string terminator.
        mask[i] = 1;
        if (i + 1 < text.length) mask[i + 1] = 1;
        i++;
        continue;
      }
      if (ch === 0x22 /* " */) {
        inString = false;
        continue;
      }
      mask[i] = 1;
      continue;
    }

    if (ch === 0x22 /* " */) inString = true;
  }

  return mask;
}

/**
 * Extract the first top-level JSON object or array from free-form text.
 *
 * Useful when the LLM embeds valid JSON inside narration text without fences.
 * Finds the first `{` or `[` and the last matching `}` or `]`.
 *
 * Returns null if no JSON container is found.
 */
export function extractJsonObject(text: string): string | null {
  const objStart = text.indexOf("{");
  const arrStart = text.indexOf("[");

  // Determine which comes first
  let start: number;
  let closeChar: string;
  if (objStart === -1 && arrStart === -1) return null;
  if (objStart === -1) {
    start = arrStart;
    closeChar = "]";
  } else if (arrStart === -1) {
    start = objStart;
    closeChar = "}";
  } else if (objStart < arrStart) {
    start = objStart;
    closeChar = "}";
  } else {
    start = arrStart;
    closeChar = "]";
  }

  const end = text.lastIndexOf(closeChar);
  if (end <= start) return null;

  return text.slice(start, end + 1);
}

/**
 * Find the span of a balanced `{...}` or `[...]` container starting at
 * `openIndex`, tracking bracket nesting depth and string state (respecting
 * escaped quotes) so prose braces before or inside the real payload don't
 * mis-slice it. Returns the end index (inclusive) of the matching closer, or
 * -1 if the container never closes.
 */
function findBalancedSpanEnd(text: string, openIndex: number): number {
  const openChar = text[openIndex];
  const closeChar = openChar === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === openChar) {
      depth++;
    } else if (ch === closeChar) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Cap on candidate openers tried per call — each candidate's balanced-span
 *  scan is O(text.length), so an adversarial/malformed response with many
 *  bare `{`/`[` characters and no valid JSON must not become O(n^2) on the
 *  retry-storm path. */
const MAX_JSON_CANDIDATES = 50;

/**
 * Scan `text` for `openChar`/matching-closer candidates in order, and return
 * the parsed value of the first candidate whose balanced span is valid JSON.
 * This handles prose braces preceding the real payload (e.g.
 * `the { payload } was: {"a": 1}`) — the first candidate is structurally
 * balanced but not valid JSON, so the scan moves on to the next `{`.
 * Returns undefined when no candidate parses.
 */
function parseFirstBalancedJsonCandidate<T>(text: string, openChar: "{" | "["): T | undefined {
  let candidates = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== openChar) continue;
    if (candidates++ >= MAX_JSON_CANDIDATES) return undefined;
    const end = findBalancedSpanEnd(text, i);
    if (end === -1) continue;
    try {
      return JSON.parse(stripTrailingCommas(text.slice(i, end + 1))) as T;
    } catch {
      /* this candidate's span isn't valid JSON — try the next one */
    }
  }
  return undefined;
}

/**
 * Wrap a prompt to instruct the LLM to respond with JSON only.
 *
 * Adds a JSON-only instruction at the top (primacy) and a reinforcement
 * reminder at the bottom (recency) — both improve compliance on cheap models.
 *
 * Pair with the multi-tier extraction functions above to parse the response.
 *
 * @param prompt - The core prompt content
 * @returns The prompt wrapped with JSON-only framing
 */
export function wrapJsonPrompt(prompt: string): string {
  return `IMPORTANT: Your entire response must be a single JSON object or array. Do not explain your reasoning. Do not use markdown formatting. Output ONLY the JSON.\n\n${prompt.trim()}\n\nYOUR RESPONSE MUST START WITH { OR [ AND END WITH } OR ]. No other text.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// High-level SSOT parsers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse JSON from raw LLM output using multi-tier extraction.
 *
 * Tier 1:   Direct JSON.parse (clean responses)
 * Tier 1.5: Explicit ```json fence — prioritised over generic fences to avoid
 *           matching an earlier plain ``` fence (e.g. bun test output blocks)
 * Tier 2:   Generic markdown fence — non-anchored, handles preamble text
 * Tier 3a:  Bare JSON object extraction — first { … last }
 * Tier 3b:  Bare JSON array extraction — first [ … last ] (fallback)
 *
 * Tier 3 tries objects before arrays because almost all LLM responses are
 * objects; this avoids the bug where "[7.00ms]" in assistant narration is
 * mistaken for the start of a JSON array.
 *
 * @throws {SyntaxError} when all tiers fail to produce valid JSON
 */
export function parseLLMJson<T = unknown>(text: string): T {
  const trimmed = text.trim();

  // Tier 1: direct parse
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    /* not raw JSON */
  }

  // Tier 1.5: explicit ```json fence (must come before generic fence search)
  const jsonFenceContent = trimmed.match(/```json\s*\n([\s\S]*?)\n?\s*```/)?.[1];
  if (jsonFenceContent) {
    try {
      return JSON.parse(stripTrailingCommas(jsonFenceContent)) as T;
    } catch {
      /* json-tagged fence content not valid JSON */
    }
  }

  // Tier 2: generic markdown fence
  const fromFence = extractJsonFromMarkdown(trimmed);
  if (fromFence !== trimmed) {
    try {
      return JSON.parse(stripTrailingCommas(fromFence)) as T;
    } catch {
      /* fence content not valid JSON */
    }
  }

  // Tier 3a: bare JSON object — brace-balanced scan for { … }, trying each
  // `{` candidate in order (handles prose braces before the real payload).
  const objResult = parseFirstBalancedJsonCandidate<T>(trimmed, "{");
  if (objResult !== undefined) return objResult;

  // Tier 3b: bare JSON array — fallback to a bracket-balanced [ … ] scan
  const arrResult = parseFirstBalancedJsonCandidate<T>(trimmed, "[");
  if (arrResult !== undefined) return arrResult;

  throw new SyntaxError("[llm-json] Failed to parse LLM response as JSON");
}

/**
 * Same as parseLLMJson but returns null instead of throwing when all tiers fail.
 */
export function tryParseLLMJson<T = unknown>(text: string): T | null {
  try {
    return parseLLMJson<T>(text);
  } catch {
    return null;
  }
}
