/** Message normalisation for finding identity. */

/** General normalizer safety cap. */
const MAX_ISSUE_PREFIX = 160;

/** Backticks stripped, whitespace collapsed, lowercased, truncated to a bounded prefix. */
export function normalizeIssueText(s: string): string {
  return s.replace(/`/g, "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, MAX_ISSUE_PREFIX);
}
