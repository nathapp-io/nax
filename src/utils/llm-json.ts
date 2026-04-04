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
 */
export function stripTrailingCommas(text: string): string {
  return text.replace(/,\s*([}\]])/g, "$1");
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
