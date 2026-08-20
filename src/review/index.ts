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
// re-exports `./builders/review-builder`. Import `runReview` from
// `@/review/runner` instead.
//
// `review-builder.ts` reaches `SEMANTIC_CATEGORY_ENUM_LINE` through the
// `./semantic-categories` nested barrel rather than this one, which avoids the
// independent cycles `./adversarial` and `./review-iteration-store` close back
// through `@/prompts`.
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
