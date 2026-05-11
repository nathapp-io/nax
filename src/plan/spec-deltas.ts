/**
 * Spec-deltas markdown formatter — US-004 AC4
 *
 * Formats blocker findings from plan-checklist verifier into
 * human-readable markdown with sections for:
 * - Contradicted spec claims
 * - Unverified spec claims (factual, not intent)
 * - Spec gaps surfaced by codebase
 */

import type { FactsManifest } from "@/debate/facts-manifest";

export interface VerifierFinding {
  checklistItem: string;
  severity: "blocker" | "major" | "minor";
  message?: string;
  specId?: string;
  gapId?: string;
  [key: string]: unknown;
}

export function formatSpecDeltas(_blockers: VerifierFinding[], _manifest: FactsManifest): string {
  throw new Error("not implemented");
}
