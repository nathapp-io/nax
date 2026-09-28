/**
 * Numeric AC cross-reference detection.
 *
 * `nax plan` is instructed to write one assertion per AC, so when it splits a
 * compound criterion into two it renumbers the rest. The text of an existing AC
 * can still point at the previous number, and a reader who follows that pointer
 * reads a different criterion than the author intended. This module is the SSOT
 * for "does this text point at another criterion by number?".
 *
 * The matcher first strips every inline code span (text between a pair of
 * backticks), then collects each match of `\bAC[- ](\d+)\b`. A backticked
 * `AC-1: a` is data — a test title quoted in a description, for example — not
 * a pointer at another criterion, and treating it as one would warn on
 * perfectly innocent prose.
 *
 * `AC-ERROR` and `AC-HOOK` carry no digits and never match. The function
 * normalises the space form `AC 14` to `AC-14` and deduplicates in first-seen
 * order, so callers see the same shape regardless of how the spec was written.
 */

/** Match a backticked span — single-line, single-pair. Multi-line code blocks are handled by callers that need them. */
const INLINE_CODE_SPAN = /`[^`]*`/g;
/** Match an `AC-<digits>` or `AC <digits>` token followed by a word boundary. */
const AC_NUMERIC = /\bAC[- ](\d+)\b/g;

/**
 * Return every numeric AC reference found in `text`, in first-seen order,
 * deduplicated and normalised to `AC-<digits>`.
 *
 * Inline code spans are stripped before matching, so a quoted `AC-1: a` (a test
 * title, say) does not register as a pointer at another criterion.
 *
 * @example
 * findAcNumericReferences("In the AC-7 shape, a write fails"); // ["AC-7"]
 * findAcNumericReferences("Given the AC 14 setup, the call is rejected"); // ["AC-14"]
 * findAcNumericReferences("AC-3 holds, then AC-12 and AC-3 again"); // ["AC-3", "AC-12"]
 */
export function findAcNumericReferences(text: string): string[] {
  const withoutCode = text.replace(INLINE_CODE_SPAN, "");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of withoutCode.matchAll(AC_NUMERIC)) {
    const ref = `AC-${match[1]}`;
    if (seen.has(ref)) continue;
    seen.add(ref);
    out.push(ref);
  }
  return out;
}
