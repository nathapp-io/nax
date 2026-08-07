import type { Finding, Iteration } from "../findings";
import type { AdversarialLLMFinding } from "./adversarial-helpers";
import { isBlockingSeverity } from "./adversarial-helpers";

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

export type PriorAppearance = { count: number; lastSeverity: string };

/**
 * Resolve a finding's prior-appearance record, trying the AC-anchored key first
 * and falling back to the prose key.
 *
 * Both directions of the mixed case are real: a story mid-flight when nax is
 * upgraded has prose-only priors and AC-anchored current findings, and a
 * reviewer that omits `acIndex` on one round produces the reverse. Whichever
 * identity has seen the defect more often wins — an undercount here silently
 * re-blocks a finding that should have demoted, which is the loop this whole
 * mechanism exists to break.
 */
export function lookupPriorAppearance(
  priorCounts: Map<string, PriorAppearance>,
  finding: { file: string; category?: string; issue: string; acIndex?: number },
): PriorAppearance | undefined {
  const acKey =
    finding.acIndex === undefined
      ? undefined
      : priorCounts.get(fingerprintFor(finding.file, finding.category, finding.issue, finding.acIndex));
  const proseKey = priorCounts.get(fingerprintFor(finding.file, finding.category, finding.issue));
  if (!acKey) return proseKey;
  if (!proseKey) return acKey;
  return acKey.count >= proseKey.count ? acKey : proseKey;
}

/**
 * One increment per prior iteration whose adversarial findings contain the
 * fingerprint (cumulative within run). `lastSeverity` is the severity in the
 * most-recent iteration containing it (iterations are chronological).
 */
export function countPriorAppearances(
  priorIterations: Iteration[],
  source: Finding["source"] = "adversarial-review",
): Map<string, PriorAppearance> {
  const counts = new Map<string, PriorAppearance>();
  for (const it of priorIterations) {
    const seenThisIter = new Map<string, string>();
    for (const f of (it.findingsAfter ?? []) as Finding[]) {
      if (f.source !== source) continue;
      // Index under BOTH keys. `finding-projection.ts` persists a valid 1-based
      // acIndex into meta, but iterations recorded before that — or by an older
      // nax — carry only prose. A current-round finding looks itself up under
      // exactly one key, so indexing both is what lets an AC-anchored lookup
      // still match a prose-only prior (and vice versa). Two entries per finding
      // never double-count: each lookup reads one key.
      const acIndex = typeof f.meta?.acIndex === "number" ? f.meta.acIndex : undefined;
      seenThisIter.set(fingerprintFor(f.file, f.category, f.message), f.severity);
      if (acIndex !== undefined) {
        seenThisIter.set(fingerprintFor(f.file, f.category, f.message, acIndex), f.severity);
      }
    }
    for (const [fp, sev] of seenThisIter) {
      const cur = counts.get(fp);
      counts.set(fp, { count: (cur?.count ?? 0) + 1, lastSeverity: sev });
    }
  }
  return counts;
}

/** Mark recurrence-demoted findings so the run-end summary + review-audit JSON can distinguish them from ordinary advisories. */
export function tagCoverageGap<T extends { meta?: Record<string, unknown> }>(findings: readonly T[]): T[] {
  return findings.map((f) => ({ ...f, meta: { ...(f.meta ?? {}), coverageGap: true } }));
}

export type RecurrenceConfig = { enabled: boolean; maxBlockingRounds: number };
export type RecurrenceResult<T = AdversarialLLMFinding> = {
  blocking: T[];
  advisory: T[];
  demoted: T[];
};

/**
 * Structural minimum `classifyRecurrence` reads. Both AdversarialLLMFinding and
 * the semantic LLMFinding satisfy it. Semantic findings carry their own
 * taxonomy (`semantic-categories.ts`), disjoint from adversarial's. That
 * disjointness is *enforced*, not merely intended: `validateLLMShape` maps any
 * off-taxonomy value (including a stray `test-gap`) to `other` at the parse
 * boundary, so the test-gap carve-out below cannot fire for a semantic finding.
 */
export interface RecurrenceCandidate {
  severity: string;
  file: string;
  issue: string;
  category?: string;
  acIndex?: number;
}

/**
 * Partition accepted adversarial findings into block / advisory / demoted.
 *
 * - test-gap (file matches a test-file pattern) → block (carve-out preserved).
 * - non-error severity → advisory.
 * - error, count n ≥ maxBlockingRounds+1 → demoted (recurrence coverage-gap).
 * - error, (n==1 OR prev sighting was error) → block (entry guard).
 * - error, else (n==2, prev not error) → advisory (oscillation suppressed).
 *
 * `demoted` is a subset reported separately for coverage-gap logging; callers
 * surface it through advisoryFindings.
 */
export function classifyRecurrence<T extends RecurrenceCandidate>(
  accepted: T[],
  priorIterations: Iteration[],
  cfg: RecurrenceConfig,
  testFileMatch: (file: string) => boolean,
  threshold: "error" | "warning" | "info",
  source: Finding["source"] = "adversarial-review",
): RecurrenceResult<T> {
  const blocking: T[] = [];
  const advisory: T[] = [];
  const demoted: T[] = [];

  if (!cfg.enabled) {
    for (const f of accepted) (isBlockingSeverity(f.severity, threshold) ? blocking : advisory).push(f);
    return { blocking, advisory, demoted };
  }

  const priorCounts = countPriorAppearances(priorIterations, source);

  for (const f of accepted) {
    // test-gap carve-out applies only to blocking severities (mirrors the
    // upstream BLOCKING_SEVERITIES gate in ac-quote-validator.ts) — a warning/
    // info test-gap must never block.
    if (f.category === "test-gap" && testFileMatch(f.file) && isBlockingSeverity(f.severity, threshold)) {
      blocking.push(f);
      continue;
    }
    if (!isBlockingSeverity(f.severity, threshold)) {
      advisory.push(f);
      continue;
    }
    const prior = lookupPriorAppearance(priorCounts, f);
    const n = (prior?.count ?? 0) + 1;
    const prevWasBlocking = prior !== undefined && isBlockingSeverity(prior.lastSeverity, threshold);

    if (n >= cfg.maxBlockingRounds + 1) {
      demoted.push(f);
    } else if (n === 1 || prevWasBlocking) {
      blocking.push(f);
    } else {
      advisory.push(f);
    }
  }
  return { blocking, advisory, demoted };
}
