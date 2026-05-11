/**
 * Citation parsing utilities for the debate system.
 *
 * Extracts factId citations from proposer outputs, computes citation rates,
 * and distributes citations across manifest categories.
 *
 * Parser priority:
 *   1. Structured JSON — if output contains a `claims` array, use parseLLMJson
 *   2. Regex fallback — extract inline [F-NNN] / (F-NNN, S-NNN) references
 *   3. Never throws — zero-rate outputs pass through to downstream verifier
 */

import { tryParseLLMJson } from "../utils/llm-json";
import type { FactsManifest } from "./facts-manifest";

export interface ParsedClaim {
  text: string;
  factIds: string[];
  cited: boolean;
}

/** Regex matching standalone factId references: [F-001], [S-042], (F-001, S-002), etc. */
const FACT_ID_RE = /\b((?:F|S)-\d{3,})\b/g;

/**
 * Extract claims from a proposer output.
 *
 * Tier 1: If the output contains a JSON object with a `claims` array
 *   (per the citation prompt schema), extract from there.
 * Tier 2: Split by paragraph and extract factId markers via regex.
 * Tier 3: Tolerance — returns [] for empty input, never throws.
 */
export function extractClaims(proposalOutput: string): ParsedClaim[] {
  if (!proposalOutput.trim()) return [];

  // Tier 1: structured JSON mode
  const parsed = tryParseLLMJson<{ claims?: unknown }>(proposalOutput);
  if (parsed !== null && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).claims)) {
    const rawClaims = (parsed as { claims: unknown[] }).claims;
    return rawClaims.map((c) => {
      const claim = c as Record<string, unknown>;
      const text = typeof claim.text === "string" ? claim.text : "";
      const factIds = Array.isArray(claim.factIds) ? (claim.factIds as string[]) : [];
      return { text, factIds, cited: factIds.length > 0 };
    });
  }

  // Tier 2: regex fallback — split by paragraph, extract factIds per chunk
  const chunks = proposalOutput
    .split(/\n\n+/)
    .map((c) => c.trim())
    .filter(Boolean);

  if (chunks.length === 0) {
    const factIds = [...proposalOutput.matchAll(FACT_ID_RE)].map((m) => m[1] as string);
    return [{ text: proposalOutput, factIds, cited: factIds.length > 0 }];
  }

  return chunks.map((chunk) => {
    const factIds = [...chunk.matchAll(FACT_ID_RE)].map((m) => m[1] as string);
    return { text: chunk, factIds, cited: factIds.length > 0 };
  });
}

/**
 * Returns the fraction of claims where `cited === true`.
 * Returns 0 for an empty claims array.
 */
export function citationRate(claims: ParsedClaim[]): number {
  if (claims.length === 0) return 0;
  return claims.filter((c) => c.cited).length / claims.length;
}

/**
 * Distributes citations across manifest categories.
 *
 * - `verifiedFacts`: citations to specClaim IDs with verification.status === "verified"
 * - `specSpans`: citations to any specClaim ID (S-xxx)
 * - `uncited`: count of claims with cited === false
 */
export function citationDistribution(
  claims: ParsedClaim[],
  manifest: FactsManifest,
): { verifiedFacts: number; specSpans: number; uncited: number } {
  const verifiedSpecIds = new Set(
    manifest.specClaims.filter((c) => c.verification.status === "verified").map((c) => c.id),
  );
  const allSpecIds = new Set(manifest.specClaims.map((c) => c.id));

  let verifiedFacts = 0;
  let specSpans = 0;
  let uncited = 0;

  for (const claim of claims) {
    if (!claim.cited) {
      uncited++;
      continue;
    }
    for (const factId of claim.factIds) {
      if (verifiedSpecIds.has(factId)) verifiedFacts++;
      if (allSpecIds.has(factId)) specSpans++;
    }
  }

  return { verifiedFacts, specSpans, uncited };
}
