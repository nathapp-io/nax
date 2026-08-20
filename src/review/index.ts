/**
 * Review Module
 *
 * Post-implementation quality verification
 */

export * from "./ac-quote-validator";
export * from "./review-iteration-store";
export * from "./truncation";
export * from "./ac-structural-counterfactual";
export * from "./adversarial";
export * from "./semantic-evidence";
export * from "./categorization";
export * from "./diff-utils";
export * from "./prepare-inputs";
export * from "./recurrence-demotion";
export * from "./finding-projection";
export * from "./types";
// `./runner` is NOT re-exported here (deliberately). It pulls in `./semantic`,
// which imports `ReviewPromptBuilder` from `@/prompts` — and `@/prompts`
// re-exports `./builders/review-builder`, which needs this barrel's
// `SEMANTIC_CATEGORY_ENUM_LINE`. Import `runReview` from `../../review/runner`
// (relative, in `src/`) or `@/review/runner` (in `test/`) instead.
//
// NOTE: dropping `./runner` alone does not let `review-builder.ts` import
// this barrel — `./adversarial` (below) closes an independent 5-hop cycle
// through `src/operations/adversarial-review.ts` -> `@/prompts` ->
// `review-builder.ts` -> back here. `review-builder.ts` must keep using the
// leaf path for `./semantic-categories` until `./adversarial` is also split
// out of this barrel.
export * from "./requote-response";
export * from "./severity";
export { validateLLMShape, parseLLMResponse } from "./semantic-helpers";
// Review acknowledgements (#1423) — shared read path for both reviewers.
export { extractAcks, MAX_ACKS } from "./acks";
export * from "./semantic-categories";
// Projection of adversarial LLM findings to the ADR-021 wire format. Already consumed
// outside src/review (src/operations/adversarial-review.ts); exported here so callers
// and tests reach it through the barrel rather than the leaf path.
export { toAdversarialReviewFindings, validateAdversarialShape } from "./adversarial-helpers";
export { categoryToFixTarget, resolveFixTarget } from "./category-fix-target";
export type { ResolveFixTargetArgs } from "./category-fix-target";
// Promoted from finding-filters: not re-exported by adversarial.ts (verify if that changes)
export { hasInspectionTrail, substantiateAdversarialFindings } from "./finding-filters";
