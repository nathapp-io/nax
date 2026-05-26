import { describe, expect, test } from "bun:test";
import { validateMockStructureFiles } from "@/operations";
import type { TestEditDeclaration } from "@/operations";
import type { ResolvedTestPatterns } from "@/test-runners";

// Mock test patterns that match *.test.ts files
const testPatterns: ResolvedTestPatterns = {
  regex: [/\.test\.ts$/],
  globs: ["**/*.test.ts"],
  pathspec: [":(exclude)src/**"],
  testDirs: ["test/unit"],
};

// Helper to create a file existence mock
function makeFileExists(existingFiles: string[]): (path: string) => Promise<boolean> {
  const set = new Set(existingFiles);
  return (path: string) => Promise.resolve(set.has(path));
}

describe("validateMockStructureFiles", () => {
  describe("non-mock_structure declarations", () => {
    test("prd_contract declaration always goes to valid", async () => {
      const decl: TestEditDeclaration = {
        reason: "prd_contract",
        file: "test/unit/foo.test.ts",
        prdQuote: "doSomething()",
        testBefore: "old",
        testAfter: "new",
      };

      const { valid, invalid } = await validateMockStructureFiles(
        [decl],
        testPatterns,
        "/repo",
        { fileExists: makeFileExists([]) },
      );

      expect(valid).toHaveLength(1);
      expect(invalid).toHaveLength(0);
      expect(valid[0]).toBe(decl);
    });

    test("lint_only declaration always goes to valid", async () => {
      const decl: TestEditDeclaration = {
        reason: "lint_only",
        file: "test/unit/foo.test.ts",
        finding: "no-non-null-assertion",
      };

      const { valid, invalid } = await validateMockStructureFiles(
        [decl],
        testPatterns,
        "/repo",
        { fileExists: makeFileExists([]) },
      );

      expect(valid).toHaveLength(1);
      expect(invalid).toHaveLength(0);
    });

    test("sibling_scope declaration always goes to valid", async () => {
      const decl: TestEditDeclaration = {
        reason: "sibling_scope",
        file: "test/unit/foo.test.ts",
        finding: "TS2304",
      };

      const { valid, invalid } = await validateMockStructureFiles(
        [decl],
        testPatterns,
        "/repo",
        { fileExists: makeFileExists([]) },
      );

      expect(valid).toHaveLength(1);
      expect(invalid).toHaveLength(0);
    });
  });

  describe("mock_structure declarations", () => {
    test("goes to valid when all files exist AND match test pattern", async () => {
      const decl: TestEditDeclaration = {
        reason: "mock_structure",
        file: "test/unit/foo.test.ts",
        files: ["test/unit/foo.test.ts", "test/unit/bar.test.ts"],
        reasonDetail: "mock setup",
      };

      const { valid, invalid } = await validateMockStructureFiles(
        [decl],
        testPatterns,
        "/repo",
        {
          fileExists: makeFileExists([
            "/repo/test/unit/foo.test.ts",
            "/repo/test/unit/bar.test.ts",
          ]),
        },
      );

      expect(valid).toHaveLength(1);
      expect(invalid).toHaveLength(0);
      expect(valid[0]).toBe(decl);
    });

    test("goes to invalid when a file does not exist on disk", async () => {
      const decl: TestEditDeclaration = {
        reason: "mock_structure",
        file: "test/unit/foo.test.ts",
        files: ["test/unit/foo.test.ts", "test/unit/missing.test.ts"],
        reasonDetail: "mock setup",
      };

      const { valid, invalid } = await validateMockStructureFiles(
        [decl],
        testPatterns,
        "/repo",
        {
          fileExists: makeFileExists([
            "/repo/test/unit/foo.test.ts",
            // missing.test.ts does NOT exist
          ]),
        },
      );

      expect(valid).toHaveLength(0);
      expect(invalid).toHaveLength(1);
      expect(invalid[0]).toBe(decl);
    });

    test("goes to invalid when file exists but does not match test pattern", async () => {
      const decl: TestEditDeclaration = {
        reason: "mock_structure",
        file: "src/utils.ts",
        files: ["src/utils.ts"],
        reasonDetail: "not a test file",
      };

      const { valid, invalid } = await validateMockStructureFiles(
        [decl],
        testPatterns,
        "/repo",
        {
          fileExists: makeFileExists(["/repo/src/utils.ts"]),
        },
      );

      expect(valid).toHaveLength(0);
      expect(invalid).toHaveLength(1);
      expect(invalid[0]).toBe(decl);
    });

    test("uses d.file when d.files is absent", async () => {
      const decl: TestEditDeclaration = {
        reason: "mock_structure",
        file: "test/unit/only.test.ts",
        reasonDetail: "only one file",
      };

      const { valid, invalid } = await validateMockStructureFiles(
        [decl],
        testPatterns,
        "/repo",
        {
          fileExists: makeFileExists(["/repo/test/unit/only.test.ts"]),
        },
      );

      expect(valid).toHaveLength(1);
      expect(invalid).toHaveLength(0);
    });

    test("single file that fails existence check → invalid", async () => {
      const decl: TestEditDeclaration = {
        reason: "mock_structure",
        file: "test/unit/gone.test.ts",
        files: ["test/unit/gone.test.ts"],
        reasonDetail: "deleted file",
      };

      const { valid, invalid } = await validateMockStructureFiles(
        [decl],
        testPatterns,
        "/repo",
        { fileExists: makeFileExists([]) },
      );

      expect(valid).toHaveLength(0);
      expect(invalid).toHaveLength(1);
    });

    test("tests relative path against pattern (not absolute)", async () => {
      // /repo/test/unit/foo.test.ts — absolute path should NOT be tested against regex,
      // only relative path "test/unit/foo.test.ts" should be
      const patterns: ResolvedTestPatterns = {
        regex: [/^test\/unit\/.+\.test\.ts$/],
        globs: [],
        pathspec: [],
        testDirs: ["test/unit"],
      };

      const decl: TestEditDeclaration = {
        reason: "mock_structure",
        file: "test/unit/foo.test.ts",
        files: ["test/unit/foo.test.ts"],
        reasonDetail: "relative path check",
      };

      const { valid } = await validateMockStructureFiles(
        [decl],
        patterns,
        "/repo",
        { fileExists: makeFileExists(["/repo/test/unit/foo.test.ts"]) },
      );

      expect(valid).toHaveLength(1);
    });

    test("mixes valid and invalid declarations correctly", async () => {
      const validDecl: TestEditDeclaration = {
        reason: "mock_structure",
        file: "test/unit/good.test.ts",
        files: ["test/unit/good.test.ts"],
        reasonDetail: "valid one",
      };
      const invalidDecl: TestEditDeclaration = {
        reason: "mock_structure",
        file: "test/unit/bad.test.ts",
        files: ["test/unit/bad.test.ts"],
        reasonDetail: "invalid one",
      };

      const { valid, invalid } = await validateMockStructureFiles(
        [validDecl, invalidDecl],
        testPatterns,
        "/repo",
        {
          fileExists: makeFileExists(["/repo/test/unit/good.test.ts"]),
          // bad.test.ts does not exist
        },
      );

      expect(valid).toHaveLength(1);
      expect(invalid).toHaveLength(1);
      expect(valid[0]).toBe(validDecl);
      expect(invalid[0]).toBe(invalidDecl);
    });
  });

  describe("injectable deps", () => {
    test("uses injectable fileExists (no real disk I/O)", async () => {
      let callCount = 0;
      const customFileExists = (path: string): Promise<boolean> => {
        callCount++;
        return Promise.resolve(path.includes("good"));
      };

      const decl: TestEditDeclaration = {
        reason: "mock_structure",
        file: "test/unit/good.test.ts",
        files: ["test/unit/good.test.ts"],
        reasonDetail: "injectable test",
      };

      await validateMockStructureFiles([decl], testPatterns, "/repo", {
        fileExists: customFileExists,
      });

      expect(callCount).toBeGreaterThan(0);
    });
  });
});
