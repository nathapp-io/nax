/**
 * Review Grounding Filter Verifier
 *
 * Extracted from src/review/semantic-debate.ts grounding-filter block.
 * Filters findings by AC grounding and determines outcome based on blocking severity.
 */

import type { AcQuotable } from "@/review";
import { filterByAcGroundingMinimal, isBlockingSeverity } from "@/review";
import type { PostDebateVerifier, PostDebateVerifierContext, PostDebateVerifierResult } from "./types";

export const reviewGroundingFilterVerifier: PostDebateVerifier = async (
  ctx: PostDebateVerifierContext,
): Promise<PostDebateVerifierResult> => {
  const rawFindings = (ctx.selectorResult.findings ?? []) as AcQuotable[];
  const acceptanceCriteria = (ctx.acceptanceCriteria ?? []) as string[];
  const threshold = ctx.blockingThreshold ?? "error";

  const { accepted } = filterByAcGroundingMinimal(rawFindings, acceptanceCriteria);

  const hasBlocking = accepted.some((f) => isBlockingSeverity(f.severity, threshold));
  const outcome =
    hasBlocking || (ctx.selectorResult.outcome === "failed" && rawFindings.length === 0) ? "failed" : "passed";

  return {
    outcome,
    findings: accepted,
    costUsd: 0,
  };
};
