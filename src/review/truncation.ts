/**
 * Shared helpers for detecting ACP output-cap truncation in LLM reviewer responses.
 *
 * Both adversarial and semantic reviewers parse JSON responses from the agent. The ACP
 * adapter tail-truncates output at MAX_AGENT_OUTPUT_CHARS, so a near-cap response is
 * almost certainly corrupted mid-stream. Detecting this lets reviewers choose a condensed
 * retry prompt (vs. a standard "return valid JSON" retry) to avoid re-triggering the cap.
 */

import { MAX_AGENT_OUTPUT_CHARS } from "../agents/acp/adapter";

export { MAX_AGENT_OUTPUT_CHARS };

/**
 * Returns true when the raw response was almost certainly truncated by the
 * ACP adapter's MAX_AGENT_OUTPUT_CHARS tail-truncation cap.
 *
 * The adapter keeps the LAST N chars (tail truncation), so a truncated response
 * ends at the cap boundary — not at a natural JSON close. Checking for a near-cap
 * length is more reliable than heuristics on the string content, since the tail
 * may start anywhere inside the JSON and may or may not end with `}`.
 */
export function looksLikeTruncatedJson(raw: string): boolean {
  return raw.trimEnd().length >= MAX_AGENT_OUTPUT_CHARS - 100;
}
