import { describe, expect, test } from "bun:test";
import { assertDefined, makeNaxConfig, makeStory } from "@test/helpers";
import type { Finding } from "@/findings";
import type { TestEditDeclaration } from "@/operations";
import { applyTestEditDeclarations, makeAutofixImplementerStrategy, makeDeclarationSink } from "@/operations";

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

/** The first element of a result array, failing the test loudly if it is absent. */
function first<T>(items: T[], label: string): T {
  const item = items[0];
  assertDefined(item, label);
  return item;
}

describe("applyTestEditDeclarations", () => {
  describe("prd_contract — valid quote", () => {
    test("re-tags matching finding from source to test", () => {
      const story = makeStory({
        description: "The function getChangeImpact(repoId: string) must return Promise<ImpactReport>",
      });
      const findings: Finding[] = [makeFinding({ file: "test/unit/foo.test.ts", fixTarget: "source" })];
      const decl: TestEditDeclaration = {
        reason: "prd_contract",
        file: "test/unit/foo.test.ts",
        prdQuote: "getChangeImpact(repoId: string)",
        testBefore: "old line",
        testAfter: "new line",
      };

      const { findings: result } = applyTestEditDeclarations(findings, [decl], story);

      expect(result).toHaveLength(1);
      expect(first(result, "result[0]").fixTarget).toBe("test");
    });

    test("attaches prdContractDeclaration to meta", () => {
      const story = makeStory({ description: "The function doSomething() is required" });
      const findings: Finding[] = [makeFinding({ file: "test/unit/bar.test.ts", fixTarget: "source" })];
      const decl: TestEditDeclaration = {
        reason: "prd_contract",
        file: "test/unit/bar.test.ts",
        prdQuote: "doSomething()",
        testBefore: "before",
        testAfter: "after",
      };

      const { findings: result } = applyTestEditDeclarations(findings, [decl], story);

      const finding = first(result, "result[0]");
      expect(finding.meta?.prdContractDeclaration).toEqual(decl);
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

      const { findings: result } = applyTestEditDeclarations(findings, [decl], story);

      const finding = first(result, "result[0]");
      expect(finding.meta?.existingKey).toBe("existingValue");
      expect(finding.meta?.prdContractDeclaration).toEqual(decl);
    });

    test("does not re-tag finding with different file", () => {
      const story = makeStory({ description: "Call processItem() for each entry" });
      const findings: Finding[] = [makeFinding({ file: "test/unit/other.test.ts", fixTarget: "source" })];
      const decl: TestEditDeclaration = {
        reason: "prd_contract",
        file: "test/unit/foo.test.ts",
        prdQuote: "processItem()",
        testBefore: "old",
        testAfter: "new",
      };

      const { findings: result } = applyTestEditDeclarations(findings, [decl], story);

      const finding = first(result, "result[0]");
      expect(finding.fixTarget).toBe("source");
      expect(finding.meta?.prdContractDeclaration).toBeUndefined();
    });

    test("does not re-tag findings that are already fixTarget: test", () => {
      const story = makeStory({ description: "Use renderWidget() in the UI" });
      const findings: Finding[] = [makeFinding({ file: "test/unit/widget.test.ts", fixTarget: "test" })];
      const decl: TestEditDeclaration = {
        reason: "prd_contract",
        file: "test/unit/widget.test.ts",
        prdQuote: "renderWidget()",
        testBefore: "old",
        testAfter: "new",
      };

      const { findings: result } = applyTestEditDeclarations(findings, [decl], story);

      // fixTarget was already "test", meta should still be set
      expect(first(result, "result[0]").fixTarget).toBe("test");
    });
  });

  describe("prd_contract — invalid quote", () => {
    test("reports a diagnostic without adding a finding when quote not found in story", () => {
      const story = makeStory({ description: "This is a story about widgets" });
      const findings: Finding[] = [makeFinding({ file: "test/unit/foo.test.ts", fixTarget: "source" })];
      const decl: TestEditDeclaration = {
        reason: "prd_contract",
        file: "test/unit/foo.test.ts",
        prdQuote: "nonExistentFunction()",
        testBefore: "old",
        testAfter: "new",
      };

      const { findings: result, diagnostics } = applyTestEditDeclarations(findings, [decl], story);

      // Original finding unchanged, and nothing appended: a rejected declaration
      // is not a defect, and an unclaimable finding dead-ends the cycle (#1327).
      expect(result).toHaveLength(1);
      expect(first(result, "result[0]").fixTarget).toBe("source");
      expect(diagnostics).toHaveLength(1);
      const diagnostic = first(diagnostics, "diagnostics[0]");
      expect(diagnostic.reason).toBe("prd_quote_mismatch");
      expect(diagnostic.file).toBe("test/unit/foo.test.ts");
      expect(diagnostic.detail).toContain("test/unit/foo.test.ts");
    });

    test("rejected quote leaves the finding claimable by autofix-implementer", () => {
      // The rejection IS the enforcement: fixTarget stays "source", so the
      // implementer still claims the finding. Asserted against the real strategy
      // predicate rather than restating the field, so a change to either side of
      // the contract fails here.
      const story = makeStory({ description: "This is a story about widgets" });
      const findings: Finding[] = [makeFinding({ file: "test/unit/foo.test.ts", fixTarget: "source" })];
      const decl: TestEditDeclaration = {
        reason: "prd_contract",
        file: "test/unit/foo.test.ts",
        prdQuote: "nonExistentFunction()",
        testBefore: "old",
        testAfter: "new",
      };

      const { findings: result } = applyTestEditDeclarations(findings, [decl], story);

      const implementer = makeAutofixImplementerStrategy(story, makeNaxConfig(), makeDeclarationSink());
      expect(result.map((f) => implementer.appliesTo(f))).toEqual([true]);
    });

    test("does not re-tag finding when quote is invalid", () => {
      const story = makeStory({ description: "A story without the quote" });
      const findings: Finding[] = [makeFinding({ file: "test/unit/foo.test.ts", fixTarget: "source" })];
      const decl: TestEditDeclaration = {
        reason: "prd_contract",
        file: "test/unit/foo.test.ts",
        prdQuote: "missingFunction()",
        testBefore: "old",
        testAfter: "new",
      };

      const { findings: result } = applyTestEditDeclarations(findings, [decl], story);

      expect(first(result, "result[0]").fixTarget).toBe("source");
    });
  });

  describe("lint_only", () => {
    test("passthrough — no changes to findings", () => {
      const story = makeStory();
      const findings: Finding[] = [makeFinding({ file: "test/unit/foo.test.ts", fixTarget: "source" })];
      const decl: TestEditDeclaration = {
        reason: "lint_only",
        file: "test/unit/foo.test.ts",
        finding: "no-non-null-assertion",
      };

      const { findings: result } = applyTestEditDeclarations(findings, [decl], story);

      expect(result).toHaveLength(1);
      expect(first(result, "result[0]").fixTarget).toBe("source");
    });
  });

  describe("sibling_scope", () => {
    test("passthrough — no changes to findings", () => {
      const story = makeStory();
      const findings: Finding[] = [makeFinding({ file: "test/unit/foo.test.ts", fixTarget: "source" })];
      const decl: TestEditDeclaration = {
        reason: "sibling_scope",
        file: "test/unit/other.test.ts",
        finding: "TS2304",
      };

      const { findings: result } = applyTestEditDeclarations(findings, [decl], story);

      expect(result).toHaveLength(1);
      expect(first(result, "result[0]").fixTarget).toBe("source");
    });
  });

  describe("invalidMockStructure", () => {
    test("reports a diagnostic without adding a finding", () => {
      const story = makeStory();
      const findings: Finding[] = [makeFinding()];
      const invalidDecl: TestEditDeclaration = {
        reason: "mock_structure",
        file: "test/unit/mock.test.ts",
        files: ["test/unit/mock.test.ts", "test/unit/other.test.ts"],
        reasonDetail: "Mock setup is wrong",
      };

      const { findings: result, diagnostics } = applyTestEditDeclarations(findings, [], story, {
        invalidMockStructure: [invalidDecl],
      });

      // The invalid handoff is already stripped by the caller before the
      // test-writer sees it — there is no fix to queue here (#1327).
      expect(result).toEqual(findings);
      expect(diagnostics).toHaveLength(1);
      const diagnostic = first(diagnostics, "diagnostics[0]");
      expect(diagnostic.reason).toBe("mock_structure_invalid_files");
      expect(diagnostic.file).toBe("test/unit/mock.test.ts");
    });

    test("includes every declared file name in the diagnostic detail", () => {
      const story = makeStory();
      const invalidDecl: TestEditDeclaration = {
        reason: "mock_structure",
        file: "test/unit/a.test.ts",
        files: ["test/unit/a.test.ts", "test/unit/b.test.ts"],
        reasonDetail: "needs mock",
      };

      const { diagnostics } = applyTestEditDeclarations([], [], story, { invalidMockStructure: [invalidDecl] });

      const diagnostic = first(diagnostics, "diagnostics[0]");
      expect(diagnostic.detail).toContain("test/unit/a.test.ts");
      expect(diagnostic.detail).toContain("test/unit/b.test.ts");
    });

    test("uses d.file when d.files is absent", () => {
      const story = makeStory();
      const invalidDecl: TestEditDeclaration = {
        reason: "mock_structure",
        file: "test/unit/only.test.ts",
        reasonDetail: "only file",
      };

      const { diagnostics } = applyTestEditDeclarations([], [], story, { invalidMockStructure: [invalidDecl] });

      expect(first(diagnostics, "diagnostics[0]").detail).toContain("test/unit/only.test.ts");
    });

    test("emits one diagnostic per invalid declaration", () => {
      const story = makeStory();
      const invalid: TestEditDeclaration[] = [
        { reason: "mock_structure", file: "test/unit/a.test.ts", reasonDetail: "a" },
        { reason: "mock_structure", file: "test/unit/b.test.ts", reasonDetail: "b" },
      ];

      const { findings: result, diagnostics } = applyTestEditDeclarations([], [], story, {
        invalidMockStructure: invalid,
      });

      expect(result).toHaveLength(0);
      expect(diagnostics.map((d) => d.file)).toEqual(["test/unit/a.test.ts", "test/unit/b.test.ts"]);
    });
  });

  describe("allowTestRetag — single-session gate (#1330)", () => {
    // fixTarget "test" hands a finding to the test-writer, and only three-session
    // registers one. A single-session implementer edits both source and tests, so
    // the declaration is informational and the finding must stay claimable by it.
    const story = () => makeStory({ description: "The function getThing() must return a Thing" });
    const decl: TestEditDeclaration = {
      reason: "prd_contract",
      file: "test/unit/foo.test.ts",
      prdQuote: "getThing()",
      testBefore: "old",
      testAfter: "new",
    };

    test("allowTestRetag: false → valid quote does NOT re-tag to test", () => {
      const findings: Finding[] = [makeFinding({ file: "test/unit/foo.test.ts", fixTarget: "source" })];

      const { findings: result } = applyTestEditDeclarations(findings, [decl], story(), {
        allowTestRetag: false,
      });

      const finding = first(result, "result[0]");
      expect(finding.fixTarget).toBe("source");
      expect(finding.meta?.prdContractDeclaration).toBeUndefined();
    });

    test("allowTestRetag: false → a valid quote is NOT reported as a quote mismatch", () => {
      // The quote is genuine; only the handoff is unavailable. Emitting a
      // prd_quote_mismatch here would accuse the agent of fabricating it.
      const findings: Finding[] = [makeFinding({ file: "test/unit/foo.test.ts", fixTarget: "source" })];

      const { diagnostics } = applyTestEditDeclarations(findings, [decl], story(), { allowTestRetag: false });

      expect(diagnostics).toEqual([]);
    });

    test("allowTestRetag: false → finding stays claimable by autofix-implementer", () => {
      const findings: Finding[] = [makeFinding({ file: "test/unit/foo.test.ts", fixTarget: "source" })];

      const { findings: result } = applyTestEditDeclarations(findings, [decl], story(), {
        allowTestRetag: false,
      });

      const implementer = makeAutofixImplementerStrategy(story(), makeNaxConfig(), makeDeclarationSink());
      expect(result.map((f) => implementer.appliesTo(f))).toEqual([true]);
    });

    test("allowTestRetag: false → an invalid quote still reports a diagnostic", () => {
      const findings: Finding[] = [makeFinding({ file: "test/unit/foo.test.ts", fixTarget: "source" })];
      const badDecl: TestEditDeclaration = { ...decl, prdQuote: "nonExistentFunction()" };

      const { findings: result, diagnostics } = applyTestEditDeclarations(findings, [badDecl], story(), {
        allowTestRetag: false,
      });

      expect(first(result, "result[0]").fixTarget).toBe("source");
      expect(diagnostics.map((d) => d.reason)).toEqual(["prd_quote_mismatch"]);
    });

    test("allowTestRetag defaults to true → valid quote re-tags", () => {
      const findings: Finding[] = [makeFinding({ file: "test/unit/foo.test.ts", fixTarget: "source" })];

      const { findings: result } = applyTestEditDeclarations(findings, [decl], story());

      expect(first(result, "result[0]").fixTarget).toBe("test");
    });
  });

  describe("no unclaimable findings are ever minted (#1327)", () => {
    test("returns an empty findings array when the only input is a rejected declaration", () => {
      // The regression: a green story (validate returned []) had an advisory
      // appended here, so classifyOutcome saw a new source, the cycle looped,
      // no strategy claimed it, and the story failed "no-strategy".
      const story = makeStory({ description: "A story that does not mention the function" });
      const decl: TestEditDeclaration = {
        reason: "prd_contract",
        file: "test/unit/foo.test.ts",
        prdQuote: "nonExistentFunction()",
        testBefore: "old",
        testAfter: "new",
      };
      const invalidDecl: TestEditDeclaration = {
        reason: "mock_structure",
        file: "test/unit/mock.test.ts",
        reasonDetail: "bad handoff",
      };

      const { findings: result, diagnostics } = applyTestEditDeclarations([], [decl], story, {
        invalidMockStructure: [invalidDecl],
      });

      expect(result).toHaveLength(0);
      expect(diagnostics).toHaveLength(2);
    });
  });

  // ── AC4: test-runner finding with no fixTarget should be re-tagged on valid prd_contract ──

  describe("prd_contract — test-runner source with no fixTarget (AC4/AC5/AC10)", () => {
    test("AC4: re-tags test-runner failed-test finding with no fixTarget to test on valid prd_contract", () => {
      const story = makeStory({ description: "Call getSomething() to fetch data" });
      const findings: Finding[] = [
        {
          source: "test-runner",
          severity: "error",
          category: "failed-test",
          message: "Expected mock to be called",
          file: "test/unit/service.test.ts",
          // fixTarget intentionally absent (test-runner findings carry no fixTarget)
        },
      ];
      const decl: TestEditDeclaration = {
        reason: "prd_contract",
        file: "test/unit/service.test.ts",
        prdQuote: "getSomething()",
        testBefore: "expect(mock).not.toBeCalled()",
        testAfter: "expect(mock).toBeCalled()",
      };

      const { findings: result } = applyTestEditDeclarations(findings, [decl], story);

      expect(result[0]?.fixTarget).toBe("test");
    });

    test("AC5: lint finding with no fixTarget is NOT re-tagged on prd_contract (only test-runner source)", () => {
      const story = makeStory({ description: "Call doWork() somewhere" });
      const findings: Finding[] = [
        {
          source: "lint",
          severity: "error",
          category: "style",
          message: "Unused import",
          file: "test/unit/service.test.ts",
          // fixTarget intentionally absent
        },
      ];
      const decl: TestEditDeclaration = {
        reason: "prd_contract",
        file: "test/unit/service.test.ts",
        prdQuote: "doWork()",
        testBefore: "old",
        testAfter: "new",
      };

      const { findings: result } = applyTestEditDeclarations(findings, [decl], story);

      expect(result[0]?.fixTarget).toBeUndefined();
    });

    test("AC10: test-runner finding with no fixTarget + invalid prd_quote → diagnostic, no appended finding", () => {
      const story = makeStory({ description: "A story that does not mention the function" });
      const findings: Finding[] = [
        {
          source: "test-runner",
          severity: "error",
          category: "failed-test",
          message: "Test failed",
          file: "test/unit/service.test.ts",
        },
      ];
      const decl: TestEditDeclaration = {
        reason: "prd_contract",
        file: "test/unit/service.test.ts",
        prdQuote: "nonExistentFunction()",
        testBefore: "old",
        testAfter: "new",
      };

      const { findings: result, diagnostics } = applyTestEditDeclarations(findings, [decl], story);

      expect(result).toHaveLength(1);
      expect(diagnostics[0]?.reason).toBe("prd_quote_mismatch");
    });

    test("AC10: original test-runner finding retains no fixTarget after invalid prd_quote", () => {
      const story = makeStory({ description: "A story without the quote" });
      const findings: Finding[] = [
        {
          source: "test-runner",
          severity: "error",
          category: "failed-test",
          message: "Test failed",
          file: "test/unit/service.test.ts",
        },
      ];
      const decl: TestEditDeclaration = {
        reason: "prd_contract",
        file: "test/unit/service.test.ts",
        prdQuote: "missingFunction()",
        testBefore: "old",
        testAfter: "new",
      };

      const { findings: result } = applyTestEditDeclarations(findings, [decl], story);

      expect(result[0]?.fixTarget).toBeUndefined();
    });
  });

  describe("immutability", () => {
    test("does not mutate input findings array", () => {
      const story = makeStory({ description: "Call doWork() somewhere" });
      const original: Finding[] = [makeFinding({ file: "test/unit/foo.test.ts", fixTarget: "source" })];
      const originalRef = original[0];
      const decl: TestEditDeclaration = {
        reason: "prd_contract",
        file: "test/unit/foo.test.ts",
        prdQuote: "doWork()",
        testBefore: "old",
        testAfter: "new",
      };

      const { findings: result } = applyTestEditDeclarations(original, [decl], story);

      // Input array not mutated
      expect(original).toHaveLength(1);
      expect(original[0]).toBe(originalRef);
      expect(first(original, "original[0]").fixTarget).toBe("source");
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
