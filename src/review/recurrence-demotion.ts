import type { Finding } from "../findings";
import type { Iteration } from "../findings";

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
 * Fingerprint = file + category + normalized issue TOPIC PREFIX. Excludes line
 * number (shifts as code changes) and acIndex (only in Finding.meta on prior
 * rounds, which is not load-bearing-branchable). The issue text is truncated to
 * FP_ISSUE_PREFIX so tail rephrasing does not create a new fingerprint. Used as
 * a plain Map key.
 */
export function fingerprintFor(file: string | undefined, category: string | undefined, text: string): string {
  const normFile = (file ?? "").replace(/\\/g, "/");
  return `${normFile}|${category ?? ""}|${normalizeIssueText(text).slice(0, FP_ISSUE_PREFIX)}`;
}

export type PriorAppearance = { count: number; lastSeverity: string };

/**
 * One increment per prior iteration whose adversarial findings contain the
 * fingerprint (cumulative within run). `lastSeverity` is the severity in the
 * most-recent iteration containing it (iterations are chronological).
 */
export function countPriorAppearances(priorIterations: Iteration[]): Map<string, PriorAppearance> {
  const counts = new Map<string, PriorAppearance>();
  for (const it of priorIterations) {
    const seenThisIter = new Map<string, string>();
    for (const f of (it.findingsAfter ?? []) as Finding[]) {
      if (f.source !== "adversarial-review") continue;
      const fp = fingerprintFor(f.file, f.category, f.message);
      seenThisIter.set(fp, f.severity);
    }
    for (const [fp, sev] of seenThisIter) {
      const cur = counts.get(fp);
      counts.set(fp, { count: (cur?.count ?? 0) + 1, lastSeverity: sev });
    }
  }
  return counts;
}

import type { AdversarialLLMFinding } from "./adversarial-helpers";
import { isBlockingSeverity } from "./adversarial-helpers";

export type RecurrenceConfig = { enabled: boolean; maxBlockingRounds: number };
export type RecurrenceResult = {
  blocking: AdversarialLLMFinding[];
  advisory: AdversarialLLMFinding[];
  demoted: AdversarialLLMFinding[];
};

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
export function classifyRecurrence(
  accepted: AdversarialLLMFinding[],
  priorIterations: Iteration[],
  cfg: RecurrenceConfig,
  testFileMatch: (file: string) => boolean,
  threshold: "error" | "warning" | "info",
): RecurrenceResult {
  const blocking: AdversarialLLMFinding[] = [];
  const advisory: AdversarialLLMFinding[] = [];
  const demoted: AdversarialLLMFinding[] = [];

  if (!cfg.enabled) {
    for (const f of accepted) (isBlockingSeverity(f.severity, threshold) ? blocking : advisory).push(f);
    return { blocking, advisory, demoted };
  }

  const priorCounts = countPriorAppearances(priorIterations);

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
    const prior = priorCounts.get(fingerprintFor(f.file, f.category, f.issue));
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
