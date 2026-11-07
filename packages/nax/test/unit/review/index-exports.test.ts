/**
 * US-003 (pipeline-review-delete) — public surface of `src/review/index.ts`.
 *
 * The barrel used to re-export seventeen review leaves (the AC-quote validator,
 * acks, adversarial/semantic helpers, categorization, category-fix-target,
 * finding-filters, no-dispatch, prepare-inputs, recurrence-demotion,
 * requote-response, the iteration store, semantic-categories, semantic-evidence)
 * whose only consumers were the pipeline review operations and prompt builders
 * deleted in US-001/US-002. The barrel keeps four modules: `diff-utils`,
 * `severity`, `truncation` and `types` — and `types` is type-only, so it
 * contributes no runtime keys.
 *
 * The surface is asserted EXACTLY rather than as "these old names are absent":
 * an exact list fails when a deleted leaf leaks back through a wildcard
 * re-export (`export * from "./x"`) just as loudly as when a retained symbol
 * goes missing, and neither failure mode is otherwise caught — this barrel has
 * no compile-time consumer for most of its surface.
 */

import { describe, expect, test } from "bun:test";

/**
 * The value-level surface after US-003: `diff-utils` (6), `severity` (3),
 * `truncation` (1). Sorted, because `Object.keys` ordering is module-evaluation
 * order, not part of the contract.
 */
const EXPECTED_SURFACE = [
  "ALWAYS_EXCLUDED",
  "DIFF_CAP_BYTES",
  "SEVERITY_RANK",
  "_diffUtilsDeps",
  "collectDiffFileList",
  "isBlockingSeverity",
  "looksLikeTruncatedJson",
  "normalizeSeverity",
  "resolveEffectiveRef",
  "truncateDiff",
] as const;

/**
 * Symbols the barrel must NOT reach any more. Listed by name (not by module) so
 * the failure message names the symbol a future re-export reintroduced.
 */
const REMOVED_SYMBOLS = [
  // ac-quote-validator
  "filterByAcGroundingMinimal",
  "filterByAcQuote",
  "filterByScopeQuote",
  "validateAcGroundingMinimal",
  "validateAcQuote",
  "validateScopeQuote",
  // acks
  "extractAcks",
  "MAX_ACKS",
  // adversarial-helpers
  "toAdversarialReviewFindings",
  "validateAdversarialShape",
  // categorization
  "MECHANICAL_REVIEW_CHECKS",
  "LLM_REVIEW_CHECKS",
  "ORDERED_MECHANICAL_REVIEW_CHECKS",
  "ORDERED_LLM_REVIEW_CHECKS",
  "isLlmReviewCheck",
  "isMechanicalReviewCheck",
  // category-fix-target
  "BLOCKING_CATEGORIES",
  "categoryToFixTarget",
  "resolveFixTarget",
  // finding-filters
  "hasInspectionTrail",
  "substantiateAdversarialFindings",
  // no-dispatch
  "toNoDispatchCheckResult",
  // prepare-inputs
  "prepareAdversarialReviewInput",
  "prepareSemanticReviewInput",
  // recurrence-demotion
  "classifyRecurrence",
  "tagCoverageGap",
  "stampRecurrenceMeta",
  "countPriorAppearances",
  "lookupPriorAppearance",
  "normalizeIssueText",
  // requote-response
  "parseRequoteResponse",
  // review-iteration-store
  "getReviewIterations",
  "recordReviewIteration",
  "MAX_ITERATIONS_PER_STORY",
  // semantic-categories
  "SEMANTIC_CATEGORIES",
  "SEMANTIC_CATEGORY_ENUM_LINE",
  "normalizeSemanticCategory",
  // semantic-evidence
  "checkFindingEvidence",
  "downgradeUnsubstantiatedFinding",
  "substantiateSemanticEvidence",
  "_evidenceDeps",
  // semantic-helpers
  "parseLLMResponse",
  "validateLLMShape",
  // diff-utils collectors deleted with the embedded-diff prompt path
  "collectDiff",
  "collectDiffStat",
  "computeTestInventory",
] as const;

describe("src/review/index.ts — US-003 public surface", () => {
  test("re-exports exactly the diff-utils, severity and truncation surface", async () => {
    const barrel: Record<string, unknown> = await import("@/review");

    expect(Object.keys(barrel).sort()).toEqual([...EXPECTED_SURFACE]);
  });

  test("no longer re-exports any deleted review leaf", async () => {
    const barrel: Record<string, unknown> = await import("@/review");

    expect(REMOVED_SYMBOLS.filter((name) => name in barrel)).toEqual([]);
  });
});
