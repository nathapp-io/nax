/**
 * The issues a feature spec names explicitly (US-007). A `Closes:` line — the keyword at the start
 * of a line, case-insensitive, outside a fenced code block — declares the issues its `#N` tokens
 * name. Prose that merely mentions an issue, a cross-repo reference (`koda#270`) and a bare number
 * are not declarations: the PR body must only claim what the spec's author wrote down.
 */

/** A line that opens or closes a fenced code block (` ``` ` or `~~~`, with an optional info string). */
const FENCE = /^\s*(?:`{3,}|~{3,})/;
/** A `Closes:` declaration; capture group 1 is the remainder of the line. */
const DECLARATION = /^\s*closes:(.*)$/i;
/** A bare issue reference on a declaration line: `#` followed by digits and nothing else. */
const ISSUE = /^#(\d+)$/;

/**
 * The closing issues of `text`, deduplicated, in first-appearance order.
 *
 * Reads only lines that begin (after leading whitespace) with `Closes:`; each line's remainder is
 * split on commas and whitespace and every token that is exactly `#<digits>` counts. A fence toggles
 * the in-code state, so a `Closes:` line inside an example block declares nothing. An unbalanced
 * fence hides everything after it — the conservative reading: never claim an issue the spec shows
 * only as an example.
 */
export function parseClosingIssues(text: string): number[] {
  const issues: number[] = [];
  const seen = new Set<number>();
  let inFence = false;
  for (const line of text.split("\n")) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const declaration = DECLARATION.exec(line);
    if (!declaration) continue;
    for (const token of (declaration[1] ?? "").split(/[\s,]+/)) {
      const match = ISSUE.exec(token);
      if (!match) continue;
      const issue = Number(match[1]);
      if (seen.has(issue)) continue;
      seen.add(issue);
      issues.push(issue);
    }
  }
  return issues;
}
