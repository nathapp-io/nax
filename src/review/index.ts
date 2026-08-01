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
export * from "./runner";
export * from "./requote-response";
export * from "./severity";
export { validateLLMShape } from "./semantic-helpers";
// Semantic finding taxonomy. `src/prompts/builders/review-builder.ts` must keep
// using the leaf path (importing this barrel from src/prompts would close a
// cycle — see that file's header); every other consumer goes through here.
export * from "./semantic-categories";
// Projection of adversarial LLM findings to the ADR-021 wire format. Already consumed
// outside src/review (src/operations/adversarial-review.ts); exported here so callers
// and tests reach it through the barrel rather than the leaf path.
export { toAdversarialReviewFindings } from "./adversarial-helpers";
export { categoryToFixTarget, resolveFixTarget } from "./category-fix-target";
export type { ResolveFixTargetArgs } from "./category-fix-target";
// Promoted from finding-filters: not re-exported by adversarial.ts (verify if that changes)
export { hasInspectionTrail, substantiateAdversarialFindings } from "./finding-filters";
