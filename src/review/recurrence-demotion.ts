import { NaxError } from "../errors";
import type { Finding, Iteration } from "../findings";
// The identity this classifier stamps a retirement from, and the one every
// retirement consumer suppresses on. Shared, dependency-free module — see its
// header for why a local copy here is a silent-desynchronisation bug.
import { fingerprintFor, normalizeIssueText } from "../findings/fingerprint";
import type { AdversarialLLMFinding } from "./adversarial-helpers";
import { isBlockingSeverity } from "./adversarial-helpers";

// Re-exported so `@/review` consumers (curator H1 heuristics imports
// `normalizeIssueText`) keep their existing entry point.
export { fingerprintFor, normalizeIssueText };

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
   * Every accepted finding stamped with `meta.recurrence.disposition`,
   * `rounds`, and `wasBlocking`. Returned in input
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
 * `meta.recurrence = { disposition, rounds, wasBlocking }`. When
 * `cfg.enabled` is false, `classified` is the unchanged input array and no
 * `meta.recurrence` is stamped — the legacy severity-only partition is preserved.
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
    return { blocking, advisory, demoted, retired, classified: accepted };
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
      classified.push(stampRecurrence(f, "blocking", rounds, true));
      continue;
    }

    let disposition: "blocking" | "advisory" | "demoted" | "retired";
    const wasBlocking = isBlocking;

    if (isBlocking) {
      if (rounds >= cfg.maxBlockingRounds + 1) {
        disposition = "demoted";
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
  wasBlocking: boolean,
): T {
  const recurrence: Record<string, unknown> = { disposition, rounds, wasBlocking };
  const existingMeta = (f as { meta?: Record<string, unknown> }).meta;
  return {
    ...f,
    meta: { ...(existingMeta ?? {}), recurrence },
  };
}
