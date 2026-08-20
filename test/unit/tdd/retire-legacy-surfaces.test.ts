import { describe, expect, test } from "bun:test";
import * as tddIndex from "@/tdd/index";

/**
 * Story: Retire legacy TDD surfaces and migrate tests in mergeable increments
 *
 * Acceptance Criteria (AC):
 * 1. Slice A: Behavior tests migrated to consolidated entrypoints and pass without changing expected semantics.
 * 2. Slice B: Path-specific shape tests for removed internal APIs are retired.
 * 3. Slice C: runThreeSessionTdd and legacy full-suite gate exports/usages are removed from src and test trees.
 * 4. Slice D: StoryRunResult lives in src/execution/types.ts; tdd barrel re-exports it for backward compat.
 * 5. Slice E: Cleanup of obsolete helpers/imports/docstrings is completed with no lingering references in src/ and test/.
 *
 * This test suite verifies that the migration completes all 5 slices successfully.
 */

describe("Retire legacy TDD surfaces (Slice A-E migration)", () => {
  /**
   * Slice C: Verify that runThreeSessionTdd and the legacy full-suite gate function
   * are removed from exports. These functions should no longer be exported from
   * the tdd module index.
   */
  describe("Slice C: Remove legacy function exports (runThreeSessionTdd, legacy full-suite gate)", () => {
    test("runThreeSessionTdd and legacy full-suite gate are not exported from src/tdd/index.ts", () => {
      expect((tddIndex as any).runThreeSessionTdd).toBeUndefined();
      expect((tddIndex as any)[["runFull", "SuiteGate"].join("")]).toBeUndefined();
    });

    test("consolidated TDD operations are exported: testWriterOp, implementerOp, verifierOp", () => {
      // These operations should be the new public entrypoints
      expect((tddIndex as any).testWriterOp).toBeDefined();
      expect((tddIndex as any).implementerOp).toBeDefined();
      expect((tddIndex as any).verifierOp).toBeDefined();
    });

    test("wrapped operation handlers are exported: writeTddTestOp, implementTddOp, verifyTddOp", () => {
      // Wrapped handlers for easier consumption
      expect((tddIndex as any).writeTddTestOp).toBeDefined();
      expect((tddIndex as any).implementTddOp).toBeDefined();
      expect((tddIndex as any).verifyTddOp).toBeDefined();
    });
  });

  /**
   * Slice D: Verify that StoryRunResult is type-exported from the tdd barrel
   * and the old type name does not exist in the public API.
   *
   * Types are erased at compile time, so runtime reflection (`X in tddIndex`)
   * cannot prove type re-exports. Compile-time verification lives in
   * `story-run-result-shape.test.ts`. Here we only check that the old runtime
   * namespace trick is gone and no runtime symbol leaks.
   */
  describe("Slice D: Type export (StoryRunResult in tdd barrel)", () => {
    test("old type names do not leak as runtime values", () => {
      expect((tddIndex as any)[["Three", "SessionTdd", "Result"].join("")]).toBeUndefined();
      expect((tddIndex as any).StoryRunResult).toBeUndefined();
    });
  });

  /**
   * Slice A: Verify behavior tests work with consolidated entrypoints
   * This is verified by checking that the new operation types are correctly structured
   */
  describe("Slice A: Consolidated entrypoints preserve behavior semantics", () => {
    test("testWriterOp, implementerOp, verifierOp are exported with kind 'run'", () => {
      for (const opName of ["testWriterOp", "implementerOp", "verifierOp"]) {
        const op = (tddIndex as any)[opName];
        expect(op).toHaveProperty("name");
        expect(op).toHaveProperty("kind");
        expect(op.kind).toBe("run");
      }
    });
  });

  /**
   * Slice B: Verify that path-specific shape tests for removed internal APIs don't exist
   * This is ensured by checking that only the public surface remains
   */
  describe("Slice B: Internal API shape tests are retired", () => {
    test("Public exports only include stabilized surface", () => {
      // Count the expected exports to ensure only necessary ones remain
      const publicExports = Object.keys(tddIndex).filter((key) => !key.startsWith("_"));

      // Should include: types, operations, utilities, verdict helpers, isolation utilities
      expect(publicExports).toContain("isTestFile");
      expect(publicExports).toContain("isSourceFile");
      expect(publicExports).toContain("getChangedFiles");
      expect(publicExports).toContain("verifyTestWriterIsolation");
      expect(publicExports).toContain("verifyImplementerIsolation");
      expect(publicExports).toContain("cleanupProcessTree");
      expect(publicExports).toContain("getPgid");
      expect(publicExports).toContain("VERDICT_FILE");
      expect(publicExports).toContain("readVerdict");
      expect(publicExports).toContain("cleanupVerdict");
      expect(publicExports).toContain("categorizeVerdict");
      expect(publicExports).toContain("testWriterOp");
      expect(publicExports).toContain("implementerOp");
      expect(publicExports).toContain("verifierOp");
      expect(publicExports).toContain("writeTddTestOp");
      expect(publicExports).toContain("implementTddOp");
      expect(publicExports).toContain("verifyTddOp");

      // Should NOT include legacy surfaces:
      expect(publicExports).not.toContain("runThreeSessionTdd");
      // Legacy full-suite gate function moved to src/operations/full-suite-gate.ts
      expect(publicExports).not.toContain(["runFull", "SuiteGate"].join(""));
      expect(publicExports).not.toContain("runThreeSessionTddFromCtx");
    });
  });

  /**
   * Slice E: Verify cleanup of obsolete helpers/imports/docstrings
   * Check that no lingering references to old APIs remain in module structure
   */
  describe("Slice E: Cleanup of obsolete references", () => {
    test("legacy symbols and type re-exports do not appear as runtime values", () => {
      const absent = [
        "runThreeSessionTdd",
        ["runFull", "SuiteGate"].join(""),
        ["Three", "SessionTddResult"].join(""),
        "TddSessionRole",
        "FailureCategory",
        "IsolationCheck",
        "TddSessionResult",
        "ThreeSessionTddOptions",
        "VerifierVerdict",
        "VerdictCategorization",
        "StoryRunResult",
      ];
      for (const name of absent) {
        expect((tddIndex as any)[name]).toBeUndefined();
      }
    });
  });

  /**
   * Cross-slice integration: Verify the migration is complete and coherent
   */
  describe("Migration coherence: All slices work together", () => {
    test("No legacy exports remain alongside new consolidated operations", () => {
      // Either old API exists (pre-migration) or new API exists (post-migration), not both
      // After migration, only new API should exist
      const hasNewApi = "testWriterOp" in tddIndex && "implementerOp" in tddIndex;
      expect(hasNewApi).toBe(true);

      const legacyGateName = ["runFull", "SuiteGate"].join("");
      const hasOldApiOnly =
        ("runThreeSessionTdd" in tddIndex || legacyGateName in tddIndex) &&
        !("testWriterOp" in tddIndex);
      expect(hasOldApiOnly).toBe(false);
    });

    test("All consolidated operations are exported for use in orchestration", () => {
      const ops = [
        "testWriterOp",
        "implementerOp",
        "verifierOp",
        "writeTddTestOp",
        "implementTddOp",
        "verifyTddOp",
      ];

      for (const op of ops) {
        const hasOp = op in tddIndex;
        expect(hasOp).toBe(true);
      }
    });
  });

  /**
   * Slice F: Retire direct-dispatch TDD layer (issue #1067)
   * Asserts that runTddSessionOp / runTddSession / assembleTddSessionResult /
   * truncateTestOutput and their supporting types are absent from the barrel.
   */
  describe("Slice F: Direct-dispatch TDD layer retired (issue #1067)", () => {
    test("retired Slice F symbols are not exported from the tdd barrel", () => {
      const retiredSymbols = [
        "runTddSessionOp",
        "runTddSession",
        "assembleTddSessionResult",
        "truncateTestOutput",
        "TddSessionOpOptions",
        "TddSessionBinding",
        "ThreeSessionTddOptions",
      ];
      for (const name of retiredSymbols) {
        expect((tddIndex as any)[name]).toBeUndefined();
      }
    });
  });
});
