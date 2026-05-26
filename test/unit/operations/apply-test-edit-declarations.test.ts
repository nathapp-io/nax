import { describe, expect, test } from "bun:test";
import { applyTestEditDeclarations } from "@/operations";
import type { Finding } from "@/findings";
import type { TestEditDeclaration } from "@/operations";
import { makeStory } from "@test/helpers";

// Helper to create a basic source-targeted finding
function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    source: "lint",
    severity: "error",
    category: "style",
    message: "A lint error",
    file: "src/foo.ts",
    fixTarget: "source",
    ...overrides,
  };
}

describe("applyTestEditDeclarations", () => {
  describe("prd_contract — valid quote", () => {
    test("re-tags matching finding from source to test", () => {
      const story = makeStory({ description: "The function getChangeImpact(repoId: string) must return Promise<ImpactReport>" });
      const findings: Finding[] = [
        makeFinding({ file: "test/unit/foo.test.ts", fixTarget: "source" }),
      ];
      const decl: TestEditDeclaration = {
        reason: "prd_contract",
        file: "test/unit/foo.test.ts",
        prdQuote: "getChangeImpact(repoId: string)",
        testBefore: "old line",
        testAfter: "new line",
      };

      const result = applyTestEditDeclarations(findings, [decl], story);

      expect(result).toHaveLength(1);
      expect(result[0]!.fixTarget).toBe("test");
    });

    test("attaches prdContractDeclaration to meta", () => {
      const story = makeStory({ description: "The function doSomething() is required" });
      const findings: Finding[] = [
        makeFinding({ file: "test/unit/bar.test.ts", fixTarget: "source" }),
      ];
      const decl: TestEditDeclaration = {
        reason: "prd_contract",
        file: "test/unit/bar.test.ts",
        prdQuote: "doSomething()",
        testBefore: "before",
        testAfter: "after",
      };

      const result = applyTestEditDeclarations(findings, [decl], story);

      expect(result[0]!.meta?.prdContractDeclaration).toEqual(decl);
    });

    test("preserves existing meta alongside prdContractDeclaration", () => {
      const story = makeStory({ description: "Call checkHealth() on startup" });
      const findings: Finding[] = [
        makeFinding({
          file: "test/unit/health.test.ts",
          fixTarget: "source",
          meta: { existingKey: "existingValue" },
        }),
      ];
      const decl: TestEditDeclaration = {
        reason: "prd_contract",
        file: "test/unit/health.test.ts",
        prdQuote: "checkHealth()",
        testBefore: "old",
        testAfter: "new",
      };

      const result = applyTestEditDeclarations(findings, [decl], story);

      expect(result[0]!.meta?.existingKey).toBe("existingValue");
      expect(result[0]!.meta?.prdContractDeclaration).toEqual(decl);
    });

    test("does not re-tag finding with different file", () => {
      const story = makeStory({ description: "Call processItem() for each entry" });
      const findings: Finding[] = [
        makeFinding({ file: "test/unit/other.test.ts", fixTarget: "source" }),
      ];
      const decl: TestEditDeclaration = {
        reason: "prd_contract",
        file: "test/unit/foo.test.ts",
        prdQuote: "processItem()",
        testBefore: "old",
        testAfter: "new",
      };

      const result = applyTestEditDeclarations(findings, [decl], story);

      expect(result[0]!.fixTarget).toBe("source");
      expect(result[0]!.meta?.prdContractDeclaration).toBeUndefined();
    });

    test("does not re-tag findings that are already fixTarget: test", () => {
      const story = makeStory({ description: "Use renderWidget() in the UI" });
      const findings: Finding[] = [
        makeFinding({ file: "test/unit/widget.test.ts", fixTarget: "test" }),
      ];
      const decl: TestEditDeclaration = {
        reason: "prd_contract",
        file: "test/unit/widget.test.ts",
        prdQuote: "renderWidget()",
        testBefore: "old",
        testAfter: "new",
      };

      const result = applyTestEditDeclarations(findings, [decl], story);

      // fixTarget was already "test", meta should still be set
      expect(result[0]!.fixTarget).toBe("test");
    });
  });

  describe("prd_contract — invalid quote", () => {
    test("appends advisory finding when quote not found in story", () => {
      const story = makeStory({ description: "This is a story about widgets" });
      const findings: Finding[] = [
        makeFinding({ file: "test/unit/foo.test.ts", fixTarget: "source" }),
      ];
      const decl: TestEditDeclaration = {
        reason: "prd_contract",
        file: "test/unit/foo.test.ts",
        prdQuote: "nonExistentFunction()",
        testBefore: "old",
        testAfter: "new",
      };

      const result = applyTestEditDeclarations(findings, [decl], story);

      // Original finding unchanged
      expect(result[0]!.fixTarget).toBe("source");
      // Advisory appended
      expect(result).toHaveLength(2);
      const advisory = result[1]!;
      expect(advisory.source).toBe("autofix");
      expect(advisory.severity).toBe("warning");
      expect(advisory.category).toBe("prd_quote_mismatch");
      expect(advisory.message).toContain("test/unit/foo.test.ts");
      expect(advisory.fixTarget).toBe("source");
    });

    test("does not re-tag finding when quote is invalid", () => {
      const story = makeStory({ description: "A story without the quote" });
      const findings: Finding[] = [
        makeFinding({ file: "test/unit/foo.test.ts", fixTarget: "source" }),
      ];
      const decl: TestEditDeclaration = {
        reason: "prd_contract",
        file: "test/unit/foo.test.ts",
        prdQuote: "missingFunction()",
        testBefore: "old",
        testAfter: "new",
      };

      const result = applyTestEditDeclarations(findings, [decl], story);

      expect(result[0]!.fixTarget).toBe("source");
    });
  });

  describe("lint_only", () => {
    test("passthrough — no changes to findings", () => {
      const story = makeStory();
      const findings: Finding[] = [
        makeFinding({ file: "test/unit/foo.test.ts", fixTarget: "source" }),
      ];
      const decl: TestEditDeclaration = {
        reason: "lint_only",
        file: "test/unit/foo.test.ts",
        finding: "no-non-null-assertion",
      };

      const result = applyTestEditDeclarations(findings, [decl], story);

      expect(result).toHaveLength(1);
      expect(result[0]!.fixTarget).toBe("source");
    });
  });

  describe("sibling_scope", () => {
    test("passthrough — no changes to findings", () => {
      const story = makeStory();
      const findings: Finding[] = [
        makeFinding({ file: "test/unit/foo.test.ts", fixTarget: "source" }),
      ];
      const decl: TestEditDeclaration = {
        reason: "sibling_scope",
        file: "test/unit/other.test.ts",
        finding: "TS2304",
      };

      const result = applyTestEditDeclarations(findings, [decl], story);

      expect(result).toHaveLength(1);
      expect(result[0]!.fixTarget).toBe("source");
    });
  });

  describe("invalidMockStructure", () => {
    test("appends advisory finding with category mock_structure_invalid_files", () => {
      const story = makeStory();
      const findings: Finding[] = [makeFinding()];
      const invalidDecl: TestEditDeclaration = {
        reason: "mock_structure",
        file: "test/unit/mock.test.ts",
        files: ["test/unit/mock.test.ts", "test/unit/other.test.ts"],
        reasonDetail: "Mock setup is wrong",
      };

      const result = applyTestEditDeclarations(findings, [], story, [invalidDecl]);

      expect(result).toHaveLength(2);
      const advisory = result[1]!;
      expect(advisory.source).toBe("autofix");
      expect(advisory.severity).toBe("warning");
      expect(advisory.category).toBe("mock_structure_invalid_files");
      expect(advisory.message).toContain("test/unit/mock.test.ts");
      expect(advisory.message).toContain("test/unit/other.test.ts");
      expect(advisory.fixTarget).toBe("source");
    });

    test("includes file names in advisory message", () => {
      const story = makeStory();
      const invalidDecl: TestEditDeclaration = {
        reason: "mock_structure",
        file: "test/unit/a.test.ts",
        files: ["test/unit/a.test.ts", "test/unit/b.test.ts"],
        reasonDetail: "needs mock",
      };

      const result = applyTestEditDeclarations([], [], story, [invalidDecl]);

      expect(result[0]!.message).toContain("test/unit/a.test.ts");
      expect(result[0]!.message).toContain("test/unit/b.test.ts");
    });

    test("uses d.file when d.files is absent", () => {
      const story = makeStory();
      const invalidDecl: TestEditDeclaration = {
        reason: "mock_structure",
        file: "test/unit/only.test.ts",
        reasonDetail: "only file",
      };

      const result = applyTestEditDeclarations([], [], story, [invalidDecl]);

      expect(result[0]!.message).toContain("test/unit/only.test.ts");
    });
  });

  describe("immutability", () => {
    test("does not mutate input findings array", () => {
      const story = makeStory({ description: "Call doWork() somewhere" });
      const original: Finding[] = [
        makeFinding({ file: "test/unit/foo.test.ts", fixTarget: "source" }),
      ];
      const originalRef = original[0];
      const decl: TestEditDeclaration = {
        reason: "prd_contract",
        file: "test/unit/foo.test.ts",
        prdQuote: "doWork()",
        testBefore: "old",
        testAfter: "new",
      };

      const result = applyTestEditDeclarations(original, [decl], story);

      // Input array not mutated
      expect(original).toHaveLength(1);
      expect(original[0]).toBe(originalRef);
      expect(original[0]!.fixTarget).toBe("source");
      // Result is a different array
      expect(result).not.toBe(original);
    });

    test("does not mutate input finding objects", () => {
      const story = makeStory({ description: "Call doWork() somewhere" });
      const finding = makeFinding({ file: "test/unit/foo.test.ts", fixTarget: "source" });
      const decl: TestEditDeclaration = {
        reason: "prd_contract",
        file: "test/unit/foo.test.ts",
        prdQuote: "doWork()",
        testBefore: "old",
        testAfter: "new",
      };

      applyTestEditDeclarations([finding], [decl], story);

      // Original finding object not mutated
      expect(finding.fixTarget).toBe("source");
      expect(finding.meta?.prdContractDeclaration).toBeUndefined();
    });
  });
});
