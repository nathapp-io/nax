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

export type {
  AcDroppedEntry,
  AcGroundingMinimalRejection,
  AcQuoteRejectionCode,
  ScopeQuoteRejectionCode,
} from "./ac-quote-validator";
export { filterByAcGroundingMinimal, filterByAcQuote, filterByScopeQuote } from "./ac-quote-validator";
export {
  checkFindingEvidence,
  downgradeUnsubstantiatedFinding,
  substantiateSemanticEvidence,
} from "./semantic-evidence";
export type { LLMFinding, LLMResponse } from "./semantic-helpers";
// Semantic filter primitives and shape helpers — re-exported so ops import only from this barrel.
// This keeps the dependency direction: operations/ → review/finding-filters.ts → review/*
export {
  isBlockingSeverity,
  sanitizeRefModeFindings,
  toReviewFindings,
  validateLLMShape,
} from "./semantic-helpers";

/**
 * True when the reviewer's raw response declares a non-empty `inspectedFiles`
 * array — evidence that it actually opened the changed code. Used by the
 * inspection-trail guard (#3A) to distinguish a genuine empty-findings pass
 * from a rubber-stamp `{"passed":true,"findings":[]}` with no investigation.
 *
 * `raw` is the already-parsed JSON object (from `tryParseLLMJson`), or null
 * when the response was unparseable (treated as "no trail").
 */
export function hasInspectionTrail(raw: Record<string, unknown> | null | undefined): boolean {
  const files = raw?.inspectedFiles;
  return Array.isArray(files) && files.some((f) => typeof f === "string" && f.trim().length > 0);
}

/**
 * The same question, answered from behaviour rather than self-report where that
 * is possible.
 *
 * `inspectedFiles` is the reviewer's own account of what it opened, and a model
 * will write one whether or not it opened anything: a native reviewer with no
 * tools wired up returned `passed:true` naming two files it had, in the same
 * response, said it could not read. Where coding tools were advertised the turn
 * reports which were actually invoked, so the claim can be checked.
 *
 * Where none were advertised there is nothing to check against — the acpx path,
 * whose tool use nax does not observe — so the self-report stands. That
 * fallback is deliberate: demanding evidence nobody can produce would re-prompt
 * every honest reviewer on that path.
 *
 * This is corroboration, not proof. A reviewer that opens one file and then
 * rubber-stamps still passes; the hole it closes is the one actually observed.
 */
export function hasCorroboratedInspectionTrail(
  raw: Record<string, unknown> | null | undefined,
  codingToolUse?: { readonly advertised: number; readonly called: readonly string[] },
): boolean {
  if (codingToolUse !== undefined && codingToolUse.advertised > 0) return codingToolUse.called.length > 0;
  return hasInspectionTrail(raw);
}

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
  repoRoot?: string;
}): Promise<AdversarialLLMFinding[]> {
  const { findings, workdir, storyId, blockingThreshold, repoRoot } = opts;
  return Promise.all(
    findings.map(async (finding) => {
      if (!isBlockingSeverity(finding.severity, blockingThreshold)) return finding;
      const evidence = await checkFindingEvidence({ finding, workdir, repoRoot });
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
