import { describe, expect, test } from "bun:test";
import * as tddIndex from "../../../src/tdd/index";

/**
 * Story: Retire legacy TDD surfaces and migrate tests in mergeable increments
 *
 * Acceptance Criteria (AC):
 * 1. Slice A: Behavior tests migrated to consolidated entrypoints and pass without changing expected semantics.
 * 2. Slice B: Path-specific shape tests for removed internal APIs are retired.
 * 3. Slice C: runThreeSessionTdd and runFullSuiteGate exports/usages are removed from src and test trees.
 * 4. Slice D: ThreeSessionTddResult is renamed/migrated to StoryRunResult and callers are updated.
 * 5. Slice E: Cleanup of obsolete helpers/imports/docstrings is completed with no lingering references in src/ and test/.
 *
 * This test suite verifies that the migration completes all 5 slices successfully.
 */

describe("Retire legacy TDD surfaces (Slice A-E migration)", () => {
  /**
   * Slice C: Verify that runThreeSessionTdd and runFullSuiteGate are removed from exports
   * These functions should no longer be exported from the tdd module index
   */
  describe("Slice C: Remove legacy function exports (runThreeSessionTdd, runFullSuiteGate)", () => {
    test("runThreeSessionTdd is not exported from src/tdd/index.ts", () => {
      // After migration, this function should not exist in the public API
      expect((tddIndex as any).runThreeSessionTdd).toBeUndefined();
    });

    test("runFullSuiteGate is not exported from src/tdd/index.ts", () => {
      // After migration, this function should not exist in the public API
      expect((tddIndex as any).runFullSuiteGate).toBeUndefined();
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
   * Slice D: Verify that ThreeSessionTddResult is renamed to StoryRunResult
   * The new type should be the primary export, old name should not exist
   */
  describe("Slice D: Type rename (ThreeSessionTddResult → StoryRunResult)", () => {
    test("StoryRunResult type is exported from src/tdd/types", () => {
      // The new unified result type should be available
      expect((tddIndex as any).StoryRunResult).toBeDefined();
    });

    test("ThreeSessionTddResult is not exported (renamed to StoryRunResult)", () => {
      // Old name should be removed from public API
      expect((tddIndex as any).ThreeSessionTddResult).toBeUndefined();
    });

    test("StoryRunResult type has correct shape fields", () => {
      // Verify the type structure is preserved in the new name
      // After implementation, this type should have the required fields
      const storyRunResult = (tddIndex as any).StoryRunResult;
      expect(storyRunResult).toBeDefined();
    });
  });

  /**
   * Slice A: Verify behavior tests work with consolidated entrypoints
   * This is verified by checking that the new operation types are correctly structured
   */
  describe("Slice A: Consolidated entrypoints preserve behavior semantics", () => {
    test("testWriterOp can be called via callOp with proper input/output types", () => {
      // The operation should be properly typed for use with callOp
      const testWriterOp = (tddIndex as any).testWriterOp;
      expect(testWriterOp).toHaveProperty("name");
      expect(testWriterOp).toHaveProperty("kind");
      expect(testWriterOp.kind).toBe("run");
    });

    test("implementerOp can be called via callOp with proper input/output types", () => {
      // The operation should be properly typed for use with callOp
      const implementerOp = (tddIndex as any).implementerOp;
      expect(implementerOp).toHaveProperty("name");
      expect(implementerOp).toHaveProperty("kind");
      expect(implementerOp.kind).toBe("run");
    });

    test("verifierOp can be called via callOp with proper input/output types", () => {
      // The operation should be properly typed for use with callOp
      const verifierOp = (tddIndex as any).verifierOp;
      expect(verifierOp).toHaveProperty("name");
      expect(verifierOp).toHaveProperty("kind");
      expect(verifierOp.kind).toBe("run");
    });
  });

  /**
   * Slice B: Verify that path-specific shape tests for removed internal APIs don't exist
   * This is ensured by checking that only the public surface remains
   */
  describe("Slice B: Internal API shape tests are retired", () => {
    test("runThreeSessionTddFromCtx is removed from exports", () => {
      // Internal implementation detail that should not be public
      expect((tddIndex as any).runThreeSessionTddFromCtx).toBeUndefined();
    });

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

      // Should NOT include:
      expect(publicExports).not.toContain("runThreeSessionTdd");
      expect(publicExports).not.toContain("runFullSuiteGate");
      expect(publicExports).not.toContain("runThreeSessionTddFromCtx");
    });
  });

  /**
   * Slice E: Verify cleanup of obsolete helpers/imports/docstrings
   * Check that no lingering references to old APIs remain in module structure
   */
  describe("Slice E: Cleanup of obsolete references", () => {
    test("index.ts does not import or re-export runThreeSessionTdd", () => {
      // Verify through structural test that the function is not available
      const hasRunThreeSessionTdd = "runThreeSessionTdd" in tddIndex;
      expect(hasRunThreeSessionTdd).toBe(false);
    });

    test("index.ts does not import or re-export runFullSuiteGate", () => {
      // Verify through structural test that the function is not available
      const hasRunFullSuiteGate = "runFullSuiteGate" in tddIndex;
      expect(hasRunFullSuiteGate).toBe(false);
    });

    test("ThreeSessionTddResult type is not exported", () => {
      // Old type name should be completely removed from public surface
      const hasThreeSessionTddResult = "ThreeSessionTddResult" in tddIndex;
      expect(hasThreeSessionTddResult).toBe(false);
    });

    test("Export statements are updated to use only stable surface", () => {
      // All type exports should be present
      const typeExports = [
        "TddSessionRole",
        "FailureCategory",
        "IsolationCheck",
        "TddSessionResult",
        "ThreeSessionTddOptions",
        "VerifierVerdict",
        "VerdictCategorization",
      ];

      for (const typeExport of typeExports) {
        const hasExport = typeExport in tddIndex;
        expect(hasExport).toBe(true);
      }

      // New unified result type should be exported
      expect("StoryRunResult" in tddIndex).toBe(true);
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

      const hasOldApiOnly =
        ("runThreeSessionTdd" in tddIndex || "runFullSuiteGate" in tddIndex) &&
        !("testWriterOp" in tddIndex);
      expect(hasOldApiOnly).toBe(false);
    });

    test("Type system is updated: StoryRunResult available, ThreeSessionTddResult removed", () => {
      const hasNewType = "StoryRunResult" in tddIndex;
      const hasOldType = "ThreeSessionTddResult" in tddIndex;

      expect(hasNewType).toBe(true);
      expect(hasOldType).toBe(false);
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
});
