/**
 * Review Module
 *
 * Post-implementation quality verification
 *
 * Deliberately narrow (US-003, pipeline-review-delete): the seventeen review
 * leaves this barrel used to re-export (the AC-quote validator, acks,
 * adversarial/semantic helpers, categorization, category-fix-target,
 * finding-filters, no-dispatch, prepare-inputs, recurrence-demotion,
 * requote-response, the iteration store, semantic-categories, semantic-evidence)
 * existed for the pipeline review operations and prompt builders removed in
 * US-001/US-002. What is left is the surface live code still reaches for: the
 * diff collectors, the severity vocabulary, the truncation predicate, and the
 * review types.
 */

export * from "./diff-utils";
// `./runner` is NOT re-exported here (deliberately). Import `runReview` from
// `@/review/runner` instead.
export * from "./severity";
export * from "./truncation";
export * from "./types";
