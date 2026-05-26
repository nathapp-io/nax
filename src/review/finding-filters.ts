/**
 * Filter primitives barrel — canonical import point for op verify() implementations.
 *
 * Dependency direction: operations/ → review/finding-filters.ts → review/{semantic-evidence, ac-quote-validator, semantic-helpers}
 * No back-edge to operations/ is permitted from this module.
 */

import type { AdversarialLLMFinding } from "./adversarial-helpers";
import { isBlockingSeverity } from "./adversarial-helpers";
import {
  ADVERSARIAL_FINDING_DOWNGRADED_EVENT,
  checkFindingEvidence,
  downgradeUnsubstantiatedFinding,
} from "./semantic-evidence";

// Semantic filter primitives and shape helpers — re-exported so ops import only from this barrel.
// This keeps the dependency direction: operations/ → review/finding-filters.ts → review/*
export {
  sanitizeRefModeFindings,
  isBlockingSeverity,
  toReviewFindings,
  validateLLMShape,
} from "./semantic-helpers";
export type { LLMFinding, LLMResponse } from "./semantic-helpers";
export {
  substantiateSemanticEvidence,
  checkFindingEvidence,
  downgradeUnsubstantiatedFinding,
} from "./semantic-evidence";
export { filterByAcGroundingMinimal, filterByAcQuote } from "./ac-quote-validator";
export type { AcQuoteRejectionCode, AcDroppedEntry, AcGroundingMinimalRejection } from "./ac-quote-validator";

/**
 * Per-finding adversarial evidence substantiation.
 * Extracted from src/review/adversarial.ts:393-409.
 * Blocking findings whose verifiedBy.observed does not match HEAD are downgraded to
 * "unverifiable". Non-blocking findings pass through unchanged.
 */
export async function substantiateAdversarialFindings(opts: {
  findings: AdversarialLLMFinding[];
  workdir: string;
  storyId: string;
  blockingThreshold: "error" | "warning" | "info";
}): Promise<AdversarialLLMFinding[]> {
  const { findings, workdir, storyId, blockingThreshold } = opts;
  return Promise.all(
    findings.map(async (finding) => {
      if (!isBlockingSeverity(finding.severity, blockingThreshold)) return finding;
      const evidence = await checkFindingEvidence({ finding, workdir });
      if (evidence.status !== "unmatched" && evidence.status !== "missing-observed") return finding;
      return downgradeUnsubstantiatedFinding({
        finding,
        storyId,
        event: ADVERSARIAL_FINDING_DOWNGRADED_EVENT,
        file: evidence.file,
        line: evidence.line,
        observed: evidence.observed,
      });
    }),
  );
}
