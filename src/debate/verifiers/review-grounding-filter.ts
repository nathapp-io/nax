/**
 * Review Grounding Filter Verifier
 *
 * Extracted from src/review/semantic-debate.ts grounding-filter block.
 * Filters findings by AC grounding and determines outcome based on blocking severity.
 */

import { filterByAcGroundingMinimal, isBlockingSeverity } from "@/review";
import type { PostDebateVerifier, PostDebateVerifierContext, PostDebateVerifierResult } from "./types";

export const reviewGroundingFilterVerifier: PostDebateVerifier = async (
  ctx: PostDebateVerifierContext,
): Promise<PostDebateVerifierResult> => {
  // Default implementation — stub for test RED phase
  // Real implementation will:
  // 1. Get findings from ctx.selectorResult
  // 2. Filter through filterByAcGroundingMinimal
  // 3. Check blocking severity
  // 4. Return outcome + filtered findings

  return {
    outcome: "passed",
    findings: [],
    costUsd: 0,
  };
};
