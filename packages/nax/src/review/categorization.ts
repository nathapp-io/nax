import type { ReviewCheckName } from "./types";

export const ORDERED_MECHANICAL_REVIEW_CHECKS: ReadonlyArray<ReviewCheckName> = ["typecheck", "build", "lint", "test"];

export const ORDERED_LLM_REVIEW_CHECKS: ReadonlyArray<ReviewCheckName> = ["semantic", "adversarial"];

export const MECHANICAL_REVIEW_CHECKS = new Set<ReviewCheckName>(ORDERED_MECHANICAL_REVIEW_CHECKS);
export const LLM_REVIEW_CHECKS = new Set<ReviewCheckName>(ORDERED_LLM_REVIEW_CHECKS);

export function isLlmReviewCheck(check: ReviewCheckName): boolean {
  return LLM_REVIEW_CHECKS.has(check);
}

export function isMechanicalReviewCheck(check: ReviewCheckName): boolean {
  return MECHANICAL_REVIEW_CHECKS.has(check);
}
