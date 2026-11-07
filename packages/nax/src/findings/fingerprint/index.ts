/**
 * Message normalisation for finding identity.
 *
 * `normalizeIssueText` is the one normaliser the cross-feature curator reads
 * (`src/plugins/builtin/curator/heuristics.ts`) when deciding whether two
 * findings describe the same defect across features. It strips backticks,
 * collapses whitespace, lowercases and clamps to a bounded prefix, so a tail
 * rephrase of the same claim normalises identically.
 *
 * The cross-round fingerprint that used to live here — `fingerprintFor`,
 * `normalizeFingerprintPath` and its shorter `FP_ISSUE_PREFIX` clamp — and its
 * last reader, the retirement stamp module that used to sit beside this one,
 * went with the findings fix cycle in C1 wave B2b-3. The curator derives its own
 * key in place rather than importing a file-led fingerprint, because a file-led
 * key can only ever group the same-file case across features.
 *
 * Pure — no I/O, no config, and no imports at all.
 */

/** General normalizer safety cap. */
const MAX_ISSUE_PREFIX = 160;

/** Backticks stripped, whitespace collapsed, lowercased, truncated to a bounded prefix. */
export function normalizeIssueText(s: string): string {
  return s.replace(/`/g, "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, MAX_ISSUE_PREFIX);
}
