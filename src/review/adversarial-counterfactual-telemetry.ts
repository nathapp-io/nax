/**
 * Issue #986 — structural-counterfactual telemetry for the adversarial reviewer.
 *
 * For every dropped and every accepted blocking finding, records what the
 * structural gate (acIndex in range + blocking category + file in diff) *would*
 * have decided. Adversarial-only: the semantic reviewer has no structural gate.
 *
 * Extracted from adversarial.ts to keep that file under the 600-line limit.
 * Pure — no I/O, no logging.
 */

import {
  type AdversarialAcceptAnalysis,
  type AdversarialDropAnalysis,
  analyzeStructuralCounterfactual,
} from "./ac-structural-counterfactual";
import type { AdversarialLLMFinding } from "./adversarial-helpers";
import type { AcDroppedEntry, AcQuoteRejectionCode } from "./finding-filters";

export interface CounterfactualTelemetryInputs {
  acDropped: AcDroppedEntry<AdversarialLLMFinding, AcQuoteRejectionCode>[];
  blockingFindings: AdversarialLLMFinding[];
  acceptanceCriteria: string[];
  /** Files touched by the story diff; empty when the diff could not be resolved. */
  diffFiles: ReadonlySet<string>;
}

export function buildCounterfactualTelemetry({
  acDropped,
  blockingFindings,
  acceptanceCriteria,
  diffFiles,
}: CounterfactualTelemetryInputs): {
  adversarialDropAnalysis: AdversarialDropAnalysis[];
  adversarialAcceptAnalysis: AdversarialAcceptAnalysis[];
} {
  const adversarialDropAnalysis: AdversarialDropAnalysis[] = acDropped.map((d) => ({
    finding: {
      file: d.finding.file ?? "<unknown>",
      line: d.finding.line ?? 0,
      severity: d.finding.severity,
      category: d.finding.category ?? "<unknown>",
      issue: d.finding.issue,
    },
    dropCode: d.code,
    acIndex: d.finding.acIndex,
    // Preserved raw so post-hoc analysis can spot schema-enum violations even
    // when the category was not blocking.
    rawCategory: d.finding.category ?? "",
    counterfactual: analyzeStructuralCounterfactual(
      { acIndex: d.finding.acIndex, category: d.finding.category, file: d.finding.file },
      acceptanceCriteria,
      diffFiles,
    ),
  }));

  const adversarialAcceptAnalysis: AdversarialAcceptAnalysis[] = blockingFindings.map((f) => ({
    finding: {
      file: f.file,
      line: f.line,
      severity: f.severity,
      category: f.category,
    },
    acIndex: f.acIndex,
    rawCategory: f.category,
    counterfactual: analyzeStructuralCounterfactual(
      { acIndex: f.acIndex, category: f.category, file: f.file },
      acceptanceCriteria,
      diffFiles,
    ),
  }));

  return { adversarialDropAnalysis, adversarialAcceptAnalysis };
}
