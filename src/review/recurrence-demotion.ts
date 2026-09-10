import { NaxError } from "../errors";
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

/**
 * Forward `meta.recurrence` from a parallel classified source onto already-mapped
 * findings. Both arrays MUST be 1:1 in order and length (the call site maps a
 * subset of `accepted` in order, and `classified` mirrors `accepted` in order).
 *
 * Needed because the LLM→Finding mapper rebuilds `meta` from scratch and would
 * otherwise drop the stamp — see the existing `coverageGap` precedent at
 * `semantic-review.ts:434` ("Tag AFTER conversion"). Reading from `classified`
 * is the source of truth so the helper stays free of bucket-dispatch logic.
 */
export function stampRecurrenceMeta<T extends { meta?: Record<string, unknown> }>(
  findings: readonly T[],
  classifiedSource: readonly { meta?: { recurrence?: unknown } }[],
): T[] {
  if (findings.length !== classifiedSource.length) {
    throw new NaxError(
      `[recurrence] stampRecurrenceMeta length mismatch: mapped=${findings.length} classified=${classifiedSource.length}`,
      "RECURRENCE_STAMP_LENGTH_MISMATCH",
      { stage: "recurrence" },
    );
  }
  return findings.map((f, i) => {
    const rec = classifiedSource[i]?.meta?.recurrence;
    if (!rec) return f;
    return { ...f, meta: { ...(f.meta ?? {}), recurrence: rec as Record<string, unknown> } };
  });
}

export type RecurrenceConfig = {
  enabled: boolean;
  maxBlockingRounds: number;
  /**
   * Cap on sub-threshold (non-blocking) appearances before a finding is
   * moved to the terminal `retired` bucket. Optional for back-compat;
   * defaults to 2 when unset.
   */
  maxAdvisoryRounds?: number;
};

/** Default cap for sub-threshold advisory retirement when `maxAdvisoryRounds` is omitted. */
export const DEFAULT_MAX_ADVISORY_ROUNDS = 2;

export type RecurrenceResult<T = AdversarialLLMFinding> = {
  blocking: T[];
  advisory: T[];
  demoted: T[];
  /**
   * Sub-threshold findings whose appearances (including the current round)
   * meet `maxAdvisoryRounds`. Terminal — the finding is reported but
   * no longer rendered into the fix lane.
   */
  retired: T[];
  /**
   * Every accepted finding stamped with `meta.recurrence.disposition` (and
   * `rounds`, and `wasBlocking` for demoted/retired). Returned in input
   * order so callers can persist the stamped set.
   */
  classified: T[];
};

/**
 * Structural minimum `classifyRecurrence` reads. Both AdversarialLLMFinding and
 * the semantic LLMFinding satisfy it. Semantic findings carry their own
 * taxonomy (`semantic-categories.ts`), disjoint from adversarial's. That
 * disjointness is *enforced*, not merely intended: `validateLLMShape` maps any
 * off-taxonomy value (including a stray `test-gap`) to `other` at the parse
 * boundary, so the test-gap carve-out below cannot fire for a semantic finding.
 *
 * `meta` is read so existing unrelated keys survive the stamp; the type is
 * widened from `AdversarialLLMFinding` to a generic bound carrying an optional
 * `meta` record. Note this is NOT the wire-format `Finding` shape — that type
 * carries `message`, while `RecurrenceCandidate` requires `issue: string`.
 * The widening is for callers that already have an LLMFinding-shaped object
 * with its own `meta` map (e.g. pre-stamped findings that need to flow through
 * classification without losing their existing meta keys).
 */
export interface RecurrenceCandidate {
  severity: string;
  file: string;
  issue: string;
  category?: string;
  acIndex?: number;
  meta?: Record<string, unknown>;
}

/**
 * Partition accepted adversarial findings into block / advisory / demoted / retired,
 * and stamp every accepted finding with its `meta.recurrence` so downstream
 * consumers can render the stamped set without re-running classification.
 *
 * The recurrence count is computed for EVERY finding (AC: the severity gate
 * selects which cap applies, the count does not depend on severity). Bucket
 * selection then:
 *
 * - test-gap on a test-file path AND severity ≥ threshold → blocking (carve-out
 *   preserved; bypasses the cap so a test-gap that has recurred 10 times still
 *   blocks).
 * - severity ≥ threshold:
 *   - n ≥ maxBlockingRounds+1 → demoted (recurrence coverage-gap, wasBlocking=true).
 *   - n == 1 OR prev sighting was blocking → blocking (entry guard).
 *   - else (n==2, prev not blocking) → advisory (oscillation suppressed).
 * - severity < threshold:
 *   - n ≥ maxAdvisoryRounds (default 2) → retired (terminal advisory, wasBlocking=false).
 *   - else → advisory.
 *
 * `classified` carries every input finding in input order, stamped with
 * `meta.recurrence = { disposition, rounds, wasBlocking? }`. When
 * `cfg.enabled` is false, `classified` is empty and no `meta.recurrence` is
 * stamped — the legacy severity-only partition is preserved.
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
  const retired: T[] = [];
  const classified: T[] = [];

  if (!cfg.enabled) {
    for (const f of accepted) (isBlockingSeverity(f.severity, threshold) ? blocking : advisory).push(f);
    return { blocking, advisory, demoted, retired, classified };
  }

  const priorCounts = countPriorAppearances(priorIterations, source);
  // `maxAdvisoryRounds` schema validation is US-002's job, but a value of 0 or
  // negative retires every sub-threshold finding on its first sighting — silently
  // emptying the advisory bucket and reproducing the surface-loss the doc warns
  // about. Clamp to the default rather than trip the foot-gun here.
  const rawMaxAdvisory = cfg.maxAdvisoryRounds ?? DEFAULT_MAX_ADVISORY_ROUNDS;
  const maxAdvisory =
    Number.isInteger(rawMaxAdvisory) && rawMaxAdvisory >= 1 ? rawMaxAdvisory : DEFAULT_MAX_ADVISORY_ROUNDS;

  for (const f of accepted) {
    const prior = lookupPriorAppearance(priorCounts, f);
    const rounds = (prior?.count ?? 0) + 1;
    const isBlocking = isBlockingSeverity(f.severity, threshold);
    const prevWasBlocking = prior !== undefined && isBlockingSeverity(prior.lastSeverity, threshold);

    // test-gap carve-out applies only to blocking severities (mirrors the
    // upstream BLOCKING_SEVERITIES gate in ac-quote-validator.ts) — a warning/
    // info test-gap must never block, but it still participates in the
    // advisory cap below.
    if (f.category === "test-gap" && testFileMatch(f.file) && isBlocking) {
      blocking.push(f);
      // wasBlocking is reserved for demoted/retired per the `classified` docstring;
      // carve-out findings never had a transition, so we don't stamp the key.
      classified.push(stampRecurrence(f, "blocking", rounds, undefined));
      continue;
    }

    let disposition: "blocking" | "advisory" | "demoted" | "retired";
    let wasBlocking: boolean | undefined;

    if (isBlocking) {
      if (rounds >= cfg.maxBlockingRounds + 1) {
        disposition = "demoted";
        wasBlocking = true;
        demoted.push(f);
      } else if (rounds === 1 || prevWasBlocking) {
        disposition = "blocking";
        blocking.push(f);
      } else {
        disposition = "advisory";
        advisory.push(f);
      }
    } else if (rounds >= maxAdvisory) {
      disposition = "retired";
      wasBlocking = false;
      retired.push(f);
    } else {
      disposition = "advisory";
      advisory.push(f);
    }

    classified.push(stampRecurrence(f, disposition, rounds, wasBlocking));
  }
  return { blocking, advisory, demoted, retired, classified };
}

/**
 * Stamp `meta.recurrence` onto a finding WITHOUT mutating the input. If the
 * input has no `meta` it is left untouched (AC: "leaves that input finding
 * without meta after the call"). If the input has unrelated `meta` keys they
 * are preserved alongside `recurrence`.
 */
function stampRecurrence<T extends RecurrenceCandidate>(
  f: T,
  disposition: "blocking" | "advisory" | "demoted" | "retired",
  rounds: number,
  wasBlocking: boolean | undefined,
): T {
  const recurrence: Record<string, unknown> = { disposition, rounds };
  if (wasBlocking !== undefined) recurrence.wasBlocking = wasBlocking;
  const existingMeta = (f as { meta?: Record<string, unknown> }).meta;
  return {
    ...f,
    meta: { ...(existingMeta ?? {}), recurrence },
  };
}
