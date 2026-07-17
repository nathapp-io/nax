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
