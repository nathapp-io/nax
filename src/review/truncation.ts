/**
 * Detects a structurally unfinished JSON response from an LLM reviewer.
 *
 * Both reviewers parse JSON from the agent. When parsing fails, the retry
 * strategy picks between two prompts: a condensed one ("your response was
 * truncated — keep every blocking finding, cap advisories") and a plain one
 * ("return valid JSON"). This predicate makes that choice.
 *
 * It used to answer by length — `raw.length >= MAX_AGENT_OUTPUT_CHARS - 100` —
 * on the premise that the ACP adapter tail-truncates output at 5000 chars. It
 * does not: `MAX_AGENT_OUTPUT_CHARS` was declared and never applied to any
 * output path. The predicate therefore meant "is this review long", and July
 * 2026 review payloads run p90 = 4,340 bytes with 164 records over 4,500 — so
 * complete, finding-rich reviews were told their response was truncated and
 * asked to send less. See docs/findings/2026-08-01-review-pipeline-gap-analysis.md.
 */

/**
 * True when `raw` opened a JSON structure it never closed — an unbalanced
 * `{`/`[`, or a string literal left open. Braces and quotes inside string
 * values are ignored, as are escaped quotes.
 *
 * Deliberately false for output that is *complete but invalid* (prose, a
 * trailing comma, a stray closing brace). That output is not truncated, so the
 * plain "return valid JSON" retry is the right prompt — asking a model to
 * shorten a response it already finished does not fix a syntax error, and on a
 * finding-rich review it costs advisory findings.
 */
export function looksLikeTruncatedJson(raw: string): boolean {
  const text = raw.trimEnd();
  if (text.length === 0) return false;

  let depth = 0;
  let inString = false;
  let escaped = false;
  let opened = false;

  for (const ch of text) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{" || ch === "[") {
      depth++;
      opened = true;
    } else if (ch === "}" || ch === "]") {
      depth--;
    }
  }

  // `opened` guards prose: a bare sentence has no structure to leave unfinished.
  return opened && (inString || depth > 0);
}
