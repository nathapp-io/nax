/**
 * US-001 (pipeline-review-delete) — the operations barrel no longer exports the
 * pipeline review operations.
 *
 * The eight review operations lost their last production caller when C1 wave
 * B2b-1 deleted the pipeline story loop. This story deletes their modules, so
 * their names must leave `src/operations/index.ts` with them: a leftover
 * re-export keeps a deleted module on the import graph. The barrel is read
 * through a dynamic `import()` so an absent name is an assertion rather than a
 * compile error — which is what lets this guard fail while the re-exports are
 * still there, and pass once they are cut.
 *
 * US-001 (pipeline-story-ops-delete) applies the same rule to the fourteen
 * fix-strategy/declaration modules: the ops and the strategies, their
 * declaration plumbing and the prompt helpers only they reached.
 */

import { describe, expect, test } from "bun:test";

/** Value-level names the barrel must stop exporting once the ops are deleted. */
const REMOVED_OP_EXPORTS = [
  "adversarialReviewOp",
  "semanticReviewOp",
  "fixReviewOp",
  "nbfWorthCheckOp",
  "recordNbfWorthCheck",
] as const;

/**
 * The fix-strategy/declaration names the barrel must stop exporting once their
 * modules are deleted (pipeline-story-ops-delete US-001).
 */
const REMOVED_FIX_STRATEGY_EXPORTS = [
  "findingsToFailedChecks",
  "applyTestEditDeclarations",
  "implementerRectifyOp",
  "makeAutofixImplementerStrategy",
  "testWriterRectifyOp",
  "makeAutofixTestWriterStrategy",
  "makeDeclarationSink",
  "_repoScopedFixDeps",
  "makeFullSuiteRectifyStrategy",
  "makeRepoScopedTestFixStrategy",
  "fullSuiteRectifyOp",
  "_mechanicalFormatFixDeps",
  "makeMechanicalFormatFixStrategy",
  "mechanicalFormatFixOp",
  "_mechanicalLintFixDeps",
  "makeMechanicalLintFixStrategy",
  "mechanicalLintFixOp",
  "rectifyOp",
  "parseTestEditDeclarations",
  "validatePrdQuote",
  "validateMockStructureFiles",
] as const;

describe("src/operations/index.ts — pipeline review operations removed", () => {
  test.each([...REMOVED_OP_EXPORTS])("no longer exports %s", async (name) => {
    const barrel = await import("@/operations");
    expect(Object.keys(barrel)).not.toContain(name);
  });
});

describe("src/operations/index.ts — fix-strategy operations removed", () => {
  test.each([...REMOVED_FIX_STRATEGY_EXPORTS])("no longer exports %s", async (name) => {
    const barrel = await import("@/operations");
    expect(Object.keys(barrel)).not.toContain(name);
  });
});
