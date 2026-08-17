/**
 * Structural Counterfactual Analyzer (Issue #986)
 *
 * Pure, read-only telemetry for the adversarial review path. For every finding
 * the validator drops or accepts, this module records whether a structural-only
 * filter (`acIndexInRange ∧ categoryBlocking ∧ fileInDiff`) would have made the
 * same decision as `filterByAcQuote`. The data drives a future keep/refine/
 * replace decision for the substring AC quote validator at N=50 dogfood drops.
 *
 * No behaviour change — analysis result is attached to the audit record and
 * never inspected by the runtime.
 */

import type { AcQuoteRejectionCode } from "./ac-quote-validator";
import type { Severity } from "./severity";

/**
 * Categories that should block a story under the structural alternative.
 * Locked at {input, error-path, abandonment, assumption} for the measurement
 * window so different projects' data is comparable (issue #986 "Out of scope").
 *
 * The adversarial prompt at adversarial-review-builder.ts:122 emits
 * `convention` and `test-gap` as advisory by design — they are deliberately
 * excluded from this set.
 */
export const BLOCKING_CATEGORIES: ReadonlySet<string> = new Set(["input", "error-path", "abandonment", "assumption"]);

export interface StructuralCounterfactual {
  acIndexInRange: boolean;
  categoryBlocking: boolean;
  fileInDiff: boolean;
  wouldSurviveStructural: boolean;
}

/** Subset of `AdversarialLLMFinding` needed for counterfactual analysis. */
export interface CounterfactualFinding {
  acIndex?: number;
  category?: string;
  file?: string;
}

/**
 * Compute the structural-counterfactual verdict for one finding.
 * Pure function — no I/O, no logging, no exceptions.
 */
export function analyzeStructuralCounterfactual(
  finding: CounterfactualFinding,
  acceptanceCriteria: string[],
  diffFiles: ReadonlySet<string>,
): StructuralCounterfactual {
  const acIndexInRange =
    typeof finding.acIndex === "number" && finding.acIndex >= 1 && finding.acIndex <= acceptanceCriteria.length;

  const categoryBlocking = typeof finding.category === "string" && BLOCKING_CATEGORIES.has(finding.category);

  const fileInDiff = typeof finding.file === "string" && diffFiles.has(finding.file);

  const wouldSurviveStructural = acIndexInRange && categoryBlocking && fileInDiff;

  return { acIndexInRange, categoryBlocking, fileInDiff, wouldSurviveStructural };
}

// ─── Persisted audit shapes (used by ReviewAuditEntry) ─────────────────────────

/**
 * Per-drop analysis attached to the audit record for every finding that
 * `filterByAcQuote` rejected. `rawCategory` preserves the model's literal
 * category string so post-hoc analysis can detect schema-enum violations
 * even when `categoryBlocking` is false.
 */
export interface AdversarialDropAnalysis {
  finding: { file: string; line: number; severity: Severity; category: string; issue: string };
  dropCode: AcQuoteRejectionCode;
  acIndex?: number;
  rawCategory: string;
  counterfactual: StructuralCounterfactual;
}

/**
 * Per-accept analysis attached to the audit record for every finding that
 * passed `filterByAcQuote` AND was at or above the blocking severity threshold.
 * Used to detect over-rejection risk if the structural alternative were adopted.
 */
export interface AdversarialAcceptAnalysis {
  finding: { file: string; line: number; severity: Severity; category: string };
  acIndex?: number;
  rawCategory: string;
  counterfactual: StructuralCounterfactual;
}
