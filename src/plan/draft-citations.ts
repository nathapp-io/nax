/**
 * Draft citation validation for plan output — US-002
 *
 * Measures the citation rate of a plan draft using the debate citation
 * utilities. The manifest parameter is reserved for future fact-ID validation.
 */

import { citationRate, extractClaims } from "../debate/citations";
import type { FactsManifest } from "../debate/facts-manifest";

export interface DraftCitationResult {
  readonly ok: boolean;
  readonly rate: number;
  readonly threshold: number;
  readonly uncitedCount: number;
}

export function validateDraftCitations(
  output: string,
  _manifest: FactsManifest,
  threshold: number,
): DraftCitationResult {
  const claims = extractClaims(output);
  const rate = citationRate(claims);
  const uncitedCount = claims.filter((c) => !c.cited).length;
  return { ok: rate >= threshold, rate, threshold, uncitedCount };
}
