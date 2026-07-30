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

  // Regression: #1385. In a monorepo the rectification agent declares paths in
  // the form it reads them from findings — repo-relative — while `packageDir` is
  // the story's package. Resolving against `packageDir` alone double-prefixed the
  // path, so a real, existing test file was rejected as nonexistent, the
  // mock-structure handoff was stripped, and the story deadlocked into a wasted
  // tier escalation (rs-stock metrics-endpoint-protection US-002).
  describe("monorepo path anchoring (packageDir !== repoRoot)", () => {
    // A Python package at apps/api whose test patterns are package-relative.
    const pyPatterns: ResolvedTestPatterns = {
      regex: [/(?:^|\/)tests(?:.*\/)?[^/]*\.py$/],
      globs: ["tests/**/*.py"],
      pathspec: [],
      testDirs: ["tests"],
    };

    test("accepts a repo-relative declaration when repoRoot is supplied", async () => {
      const decl: TestEditDeclaration = {
        reason: "mock_structure",
        file: "apps/api/tests/test_observability.py",
        files: ["apps/api/tests/test_observability.py", "apps/api/tests/test__security_headers.py"],
        reasonDetail: "existing tests assert the pre-protection /metrics contract",
      };

      const { valid, invalid } = await validateMockStructureFiles([decl], pyPatterns, "/repo/apps/api", {
        repoRoot: "/repo",
        fileExists: makeFileExists([
          "/repo/apps/api/tests/test_observability.py",
          "/repo/apps/api/tests/test__security_headers.py",
        ]),
      });

      expect(invalid).toHaveLength(0);
      expect(valid).toHaveLength(1);
      expect(valid[0]).toBe(decl);
    });

    test("still accepts a package-relative declaration for the same package", async () => {
      const decl: TestEditDeclaration = {
        reason: "mock_structure",
        file: "tests/test_observability.py",
        files: ["tests/test_observability.py"],
        reasonDetail: "package-relative form",
      };

      const { valid, invalid } = await validateMockStructureFiles([decl], pyPatterns, "/repo/apps/api", {
        repoRoot: "/repo",
        fileExists: makeFileExists(["/repo/apps/api/tests/test_observability.py"]),
      });

      expect(invalid).toHaveLength(0);
      expect(valid).toHaveLength(1);
    });

    test("pattern is tested against the package-relative form of the resolved path", async () => {
      // Anchored package-relative pattern: only "tests/..." matches, so a
      // repo-relative declaration must be rebased before the pattern test.
      const anchored: ResolvedTestPatterns = {
        regex: [/^tests\/.+\.py$/],
        globs: ["tests/**/*.py"],
        pathspec: [],
        testDirs: ["tests"],
      };

      const decl: TestEditDeclaration = {
        reason: "mock_structure",
        file: "apps/api/tests/test_observability.py",
        files: ["apps/api/tests/test_observability.py"],
        reasonDetail: "anchored pattern",
      };

      const { valid, invalid } = await validateMockStructureFiles([decl], anchored, "/repo/apps/api", {
        repoRoot: "/repo",
        fileExists: makeFileExists(["/repo/apps/api/tests/test_observability.py"]),
      });

      expect(invalid).toHaveLength(0);
      expect(valid).toHaveLength(1);
    });

    test("a file that exists under neither anchor is still invalid", async () => {
      const decl: TestEditDeclaration = {
        reason: "mock_structure",
        file: "apps/api/tests/test_missing.py",
        files: ["apps/api/tests/test_missing.py"],
        reasonDetail: "hallucinated file",
      };

      const { valid, invalid } = await validateMockStructureFiles([decl], pyPatterns, "/repo/apps/api", {
        repoRoot: "/repo",
        fileExists: makeFileExists([]),
      });

      expect(valid).toHaveLength(0);
      expect(invalid).toHaveLength(1);
      expect(invalid[0]).toBe(decl);
    });

    test("a non-test file resolved via repoRoot is still invalid", async () => {
      const decl: TestEditDeclaration = {
        reason: "mock_structure",
        file: "apps/api/src/stock_api/app.py",
        files: ["apps/api/src/stock_api/app.py"],
        reasonDetail: "source file smuggled through the handoff",
      };

      const { valid, invalid } = await validateMockStructureFiles([decl], pyPatterns, "/repo/apps/api", {
        repoRoot: "/repo",
        fileExists: makeFileExists(["/repo/apps/api/src/stock_api/app.py"]),
      });

      expect(valid).toHaveLength(0);
      expect(invalid).toHaveLength(1);
    });

    test("omitting repoRoot preserves package-relative-only resolution", async () => {
      const decl: TestEditDeclaration = {
        reason: "mock_structure",
        file: "apps/api/tests/test_observability.py",
        files: ["apps/api/tests/test_observability.py"],
        reasonDetail: "no repoRoot anchor available",
      };

      const { valid, invalid } = await validateMockStructureFiles([decl], pyPatterns, "/repo/apps/api", {
        fileExists: makeFileExists(["/repo/apps/api/tests/test_observability.py"]),
      });

      expect(valid).toHaveLength(0);
      expect(invalid).toHaveLength(1);
    });

    test("package-relative anchor wins when the file exists under both", async () => {
      // Anchored pattern matches only the package-relative rebase, so a pass
      // proves the packageDir candidate was the one used — not just probed first.
      const anchored: ResolvedTestPatterns = {
        regex: [/^tests\/.+\.py$/],
        globs: ["tests/**/*.py"],
        pathspec: [],
        testDirs: ["tests"],
      };
      const probed: string[] = [];

      const decl: TestEditDeclaration = {
        reason: "mock_structure",
        file: "tests/test_observability.py",
        files: ["tests/test_observability.py"],
        reasonDetail: "ambiguous under both anchors",
      };

      const { valid, invalid } = await validateMockStructureFiles([decl], anchored, "/repo/apps/api", {
        repoRoot: "/repo",
        fileExists: (p) => {
          probed.push(p);
          // Both a package-local and a repo-root tests/ tree exist.
          return Promise.resolve(
            p === "/repo/apps/api/tests/test_observability.py" || p === "/repo/tests/test_observability.py",
          );
        },
      });

      expect(invalid).toHaveLength(0);
      expect(valid).toHaveLength(1);
      expect(probed[0]).toBe("/repo/apps/api/tests/test_observability.py");
    });

    test("rejects a test file belonging to a different package", async () => {
      // Resolver regexes are typically unanchored, so without containment this
      // repo-relative path would match and be handed to a test-writer scoped to
      // apps/api. Cross-package spillover belongs to sibling_scope.
      const decl: TestEditDeclaration = {
        reason: "mock_structure",
        file: "packages/shared/tests/test_helpers.py",
        files: ["packages/shared/tests/test_helpers.py"],
        reasonDetail: "another package's tests",
      };

      const { valid, invalid } = await validateMockStructureFiles([decl], pyPatterns, "/repo/apps/api", {
        repoRoot: "/repo",
        fileExists: makeFileExists(["/repo/packages/shared/tests/test_helpers.py"]),
      });

      expect(valid).toHaveLength(0);
      expect(invalid).toHaveLength(1);
      expect(invalid[0]).toBe(decl);
    });

    test("rejects a path that escapes packageDir via ..", async () => {
      const decl: TestEditDeclaration = {
        reason: "mock_structure",
        file: "../shared/tests/test_helpers.py",
        files: ["../shared/tests/test_helpers.py"],
        reasonDetail: "traversal out of the package",
      };

      const { valid, invalid } = await validateMockStructureFiles([decl], pyPatterns, "/repo/apps/api", {
        repoRoot: "/repo",
        fileExists: makeFileExists(["/repo/apps/shared/tests/test_helpers.py"]),
      });

      expect(valid).toHaveLength(0);
      expect(invalid).toHaveLength(1);
    });

    test("accepts an absolute declaration inside the package", async () => {
      const decl: TestEditDeclaration = {
        reason: "mock_structure",
        file: "/repo/apps/api/tests/test_observability.py",
        files: ["/repo/apps/api/tests/test_observability.py"],
        reasonDetail: "absolute form",
      };

      const { valid, invalid } = await validateMockStructureFiles([decl], pyPatterns, "/repo/apps/api", {
        repoRoot: "/repo",
        fileExists: makeFileExists(["/repo/apps/api/tests/test_observability.py"]),
      });

      expect(invalid).toHaveLength(0);
      expect(valid).toHaveLength(1);
    });

    test("rejects an absolute declaration outside the package", async () => {
      const decl: TestEditDeclaration = {
        reason: "mock_structure",
        file: "/repo/packages/shared/tests/test_helpers.py",
        files: ["/repo/packages/shared/tests/test_helpers.py"],
        reasonDetail: "absolute, wrong package",
      };

      const { valid, invalid } = await validateMockStructureFiles([decl], pyPatterns, "/repo/apps/api", {
        repoRoot: "/repo",
        fileExists: makeFileExists(["/repo/packages/shared/tests/test_helpers.py"]),
      });

      expect(valid).toHaveLength(0);
      expect(invalid).toHaveLength(1);
    });

    test("rejects a declaration naming packageDir itself", async () => {
      const decl: TestEditDeclaration = {
        reason: "mock_structure",
        file: ".",
        files: ["."],
        reasonDetail: "directory, not a file",
      };

      const { valid, invalid } = await validateMockStructureFiles([decl], pyPatterns, "/repo/apps/api", {
        repoRoot: "/repo",
        fileExists: makeFileExists(["/repo/apps/api"]),
      });

      expect(valid).toHaveLength(0);
      expect(invalid).toHaveLength(1);
    });

    test("single-package repo (repoRoot === packageDir) resolves once", async () => {
      const seen: string[] = [];
      const decl: TestEditDeclaration = {
        reason: "mock_structure",
        file: "tests/test_observability.py",
        files: ["tests/test_observability.py"],
        reasonDetail: "single package",
      };

      const { valid } = await validateMockStructureFiles([decl], pyPatterns, "/repo", {
        repoRoot: "/repo",
        fileExists: (p) => {
          seen.push(p);
          return Promise.resolve(p === "/repo/tests/test_observability.py");
        },
      });

      expect(valid).toHaveLength(1);
      expect(seen).toEqual(["/repo/tests/test_observability.py"]);
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
