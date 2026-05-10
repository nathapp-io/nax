/**
 * Review Grounding Filter Verifier
 *
 * Extracted from src/review/semantic-debate.ts grounding-filter block.
 * Filters findings by AC grounding and determines outcome based on blocking severity.
 */

import { filterByAcGroundingMinimal, isBlockingSeverity } from "@/review";
import type { AcQuotable } from "@/review";
import type { PostDebateVerifier, PostDebateVerifierContext, PostDebateVerifierResult } from "./types";

export const reviewGroundingFilterVerifier: PostDebateVerifier = async (
  ctx: PostDebateVerifierContext,
): Promise<PostDebateVerifierResult> => {
  const rawFindings = (ctx.selectorResult.findings ?? []) as AcQuotable[];
  const acceptanceCriteria = (ctx.acceptanceCriteria ?? []) as string[];

  const { accepted } = filterByAcGroundingMinimal(rawFindings, acceptanceCriteria);

  const hasBlocking = accepted.some((f) => isBlockingSeverity(f.severity));

  return {
    outcome: hasBlocking ? "failed" : "passed",
    findings: accepted,
    costUsd: 0,
  };
};
