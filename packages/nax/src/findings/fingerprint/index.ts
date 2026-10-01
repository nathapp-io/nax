/**
 * Cross-round finding identity — `fingerprintFor` and the text normalisers it is
 * built from.
 *
 * **Single source of truth.** Two subsystems answer "is this the same finding as
 * the one retired earlier?" and MUST agree exactly:
 *
 *   - `src/review/recurrence-demotion.ts` — `classifyRecurrence` mints the
 *     `meta.recurrence` stamp (and therefore the retirement decision) from it.
 *   - `src/findings/retirement-stamp` — the carry-forward prompt and the
 *     non-blocking-fix seed filter suppress a finding whose identity matches a
 *     retired stamp.
 *
 * A drifted copy on either side is silent: the prompt would suppress a copy the
 * classifier never retired (or keep telling the reviewer to re-flag one it did),
 * and every test would still pass, because each copy is internally consistent.
 * The two consumers also sit on opposite sides of an import cycle, so the
 * primitive lives here — a dependency-free nested barrel both can reach without
 * loading the other's parent barrel (project-conventions, nested-barrel rule).
 *
 * Pure / repo-scoped — no I/O, no config, and no imports at all.
 */

/** General normalizer safety cap. */
const MAX_ISSUE_PREFIX = 160;

/**
 * Shorter "topic" prefix used ONLY for fingerprints. Deliberately smaller than
 * MAX_ISSUE_PREFIX so a tail rephrase (the reviewer appending/altering wording
 * after the core claim) still fingerprints identically across rounds. Chosen so
 * the leading claim ("window expiry is non-atomic because …") is captured while
 * trailing elaboration is ignored.
 */
const FP_ISSUE_PREFIX = 48;

/** Backticks stripped, whitespace collapsed, lowercased, truncated to a bounded prefix. */
export function normalizeIssueText(s: string): string {
  return s.replace(/`/g, "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, MAX_ISSUE_PREFIX);
}

/**
 * Path key for a fingerprint. Backslashes normalized, then leading `./` and
 * `../` segments stripped: the reviewer's cwd drifts between rounds in a
 * monorepo (the same file has been cited as `components/X.tsx`,
 * `apps/web/components/X.tsx`, and `../../apps/api/src/y.py` within one story),
 * and an unnormalized prefix fragments the key.
 */
function normalizeFingerprintPath(file: string | undefined): string {
  return (file ?? "").replace(/\\/g, "/").replace(/^(?:\.{1,2}\/)+/, "");
}

/**
 * Fingerprint identifying "the same finding" across review rounds. Excludes the
 * line number (shifts as code changes).
 *
 * **AC-anchored path (preferred).** When the finding carries an `acIndex`, the
 * key is `file + acIndex` and the prose is not consulted at all. That pair is
 * structurally stable: `acIndex` is a validated 1-based index into the story's
 * acceptance criteria, mandatory for every blocking finding (the reviewer prompt
 * requires it and `filterByAcGroundingMinimal` drops findings whose index is
 * absent or out of range), so every recurrence-demotion decision takes this path.
 *
 * **Prose fallback.** Without an `acIndex` the key degrades to
 * file + category + issue topic prefix. Retained for non-blocking findings and
 * for iterations recorded before `meta.acIndex` was persisted.
 *
 * Why the prose cannot be the primary key: the reviewer re-words the *opening
 * clause* of a finding every round, not just its tail. One defect in
 * `auth-security-hardening` US-004 was filed 8 times across 17 rounds as
 * "The stored expiresAt is never consulted…", "TTL is only written to
 * expiresAt…", "Expired replay rows are never removed or ignored…" — three
 * different keys under a prefix fingerprint, so `countPriorAppearances` never
 * reached the demotion threshold and the story never converged. Bag-of-words
 * similarity was measured against that corpus and rejected: no threshold
 * separated the story's distinct defects without also merging unrelated ones,
 * and over-merging demotes genuine blocking findings to advisory.
 *
 * `text` is the reviewer's prose as the caller holds it: `issue` on the LLM
 * wire shape, `message` on a persisted `Finding`. Both name the same field.
 */
export function fingerprintFor(
  file: string | undefined,
  category: string | undefined,
  text: string,
  acIndex?: number,
): string {
  const normFile = normalizeFingerprintPath(file);
  if (typeof acIndex === "number" && Number.isInteger(acIndex) && acIndex >= 1) {
    return `${normFile}|ac${acIndex}`;
  }
  return `${normFile}|${category ?? ""}|${normalizeIssueText(text).slice(0, FP_ISSUE_PREFIX)}`;
}
