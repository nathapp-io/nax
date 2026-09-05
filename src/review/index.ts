/**
 * Review Module
 *
 * Post-implementation quality verification
 */

export * from "./ac-quote-validator";
export * from "./ac-structural-counterfactual";
// Review acknowledgements (#1423) — shared read path for both reviewers.
export { extractAcks, MAX_ACKS } from "./acks";
// Projection of adversarial LLM findings to the ADR-021 wire format. Already consumed
// outside src/review (src/operations/adversarial-review.ts); exported here so callers
// and tests reach it through the barrel rather than the leaf path.
export { toAdversarialReviewFindings, validateAdversarialShape } from "./adversarial-helpers";
export * from "./categorization";
export type { ResolveFixTargetArgs } from "./category-fix-target";
export { categoryToFixTarget, resolveFixTarget } from "./category-fix-target";
export * from "./diff-utils";
// Promoted from finding-filters: not re-exported by adversarial.ts (verify if that changes)
export { hasInspectionTrail, substantiateAdversarialFindings } from "./finding-filters";
export * from "./prepare-inputs";
export * from "./recurrence-demotion";
// `./runner` is NOT re-exported here (deliberately). Import `runReview` from
// `@/review/runner` instead.
export * from "./requote-response";
export * from "./review-iteration-store";
export * from "./semantic-categories";
export * from "./semantic-evidence";
export { parseLLMResponse, validateLLMShape } from "./semantic-helpers";
export * from "./severity";
export * from "./truncation";
export * from "./types";
