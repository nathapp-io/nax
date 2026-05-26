import { describe, expect, test } from "bun:test";
import type { Finding } from "@/findings";
import type { FixCycleContext } from "@/findings/cycle-types";
import { makeAutofixImplementerStrategy, makeDeclarationSink } from "@/operations";
import type { AutofixImplementerOutput } from "@/operations/autofix-implementer";
import { makeNaxConfig, makeStory } from "@test/helpers";

const mockCtx = {} as any;

function makeSink() {
  return makeDeclarationSink();
}

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    source: "lint",
    severity: "error",
    category: "lint-error",
    message: "error message",
    fixTarget: "source",
    ...overrides,
  };
}

describe("makeAutofixImplementerStrategy", () => {
  test("name is autofix-implementer", () => {
    const strategy = makeAutofixImplementerStrategy(mockCtx, makeNaxConfig(), makeSink());
    expect(strategy.name).toBe("autofix-implementer");
  });

  test("fixOp name is autofix-implementer", () => {
    const strategy = makeAutofixImplementerStrategy(mockCtx, makeNaxConfig(), makeSink());
    expect(strategy.fixOp.name).toBe("autofix-implementer");
  });

  test("maxAttempts is a positive number", () => {
    const strategy = makeAutofixImplementerStrategy(mockCtx, makeNaxConfig(), makeSink());
    expect(strategy.maxAttempts).toBeGreaterThan(0);
  });

  describe("AC3: appliesTo predicate — source includes list", () => {
    test("AC3: returns true when fixTarget=source and source=lint", () => {
      const strategy = makeAutofixImplementerStrategy(mockCtx, makeNaxConfig(), makeSink());
      const finding = makeFinding({ fixTarget: "source", source: "lint" });
      expect(strategy.appliesTo(finding)).toBe(true);
    });

    test("AC3: returns true when fixTarget=source and source=typecheck", () => {
      const strategy = makeAutofixImplementerStrategy(mockCtx, makeNaxConfig(), makeSink());
      const finding = makeFinding({ fixTarget: "source", source: "typecheck" });
      expect(strategy.appliesTo(finding)).toBe(true);
    });

    test("AC3: returns true when fixTarget=source and source=semantic-review", () => {
      const strategy = makeAutofixImplementerStrategy(mockCtx, makeNaxConfig(), makeSink());
      const finding = makeFinding({ fixTarget: "source", source: "semantic-review" });
      expect(strategy.appliesTo(finding)).toBe(true);
    });

    test("AC3: returns false when fixTarget=test", () => {
      const strategy = makeAutofixImplementerStrategy(mockCtx, makeNaxConfig(), makeSink());
      const finding = makeFinding({ fixTarget: "test", source: "lint" });
      expect(strategy.appliesTo(finding)).toBe(false);
    });

    test("AC3: returns false when source=test-runner", () => {
      const strategy = makeAutofixImplementerStrategy(mockCtx, makeNaxConfig(), makeSink());
      const finding = makeFinding({ fixTarget: "source", source: "test-runner" });
      expect(strategy.appliesTo(finding)).toBe(false);
    });

    test("AC3: returns false when source is not in allowed list (adversarial-review with fixTarget=source)", () => {
      const strategy = makeAutofixImplementerStrategy(mockCtx, makeNaxConfig(), makeSink());
      const finding = makeFinding({ fixTarget: "source", source: "adversarial-review" });
      expect(strategy.appliesTo(finding)).toBe(false);
    });
  });

  test("AC2.3: buildInput converts semantic finding to ReviewCheckResult", () => {
    const story = makeStory();
    const strategy = makeAutofixImplementerStrategy(story, makeNaxConfig(), makeSink());
    const semanticFinding: Finding = {
      source: "semantic-review",
      severity: "error",
      category: "",
      message: "Fails AC-001",
      file: "src/foo.ts",
      line: 5,
    };
    const input = strategy.buildInput([semanticFinding], [], {} as FixCycleContext);
    expect(input.failedChecks).toHaveLength(1);
    expect(input.failedChecks[0]?.check).toBe("semantic");
    expect(input.failedChecks[0]?.findings).toEqual([semanticFinding]);
  });

  describe("extractApplied — sink partitioning", () => {
    function makeOutput(
      declarations: AutofixImplementerOutput["testEditDeclarations"],
      unresolvedReason?: string,
    ): AutofixImplementerOutput {
      return {
        applied: true,
        testEditDeclarations: declarations,
        ...(unresolvedReason !== undefined ? { unresolvedReason } : {}),
      };
    }

    test("pushes mock_structure declarations to sink.mockHandoffs", () => {
      const sink = makeSink();
      const strategy = makeAutofixImplementerStrategy(makeStory(), makeNaxConfig(), sink);
      const output = makeOutput([
        { reason: "mock_structure", file: "test/foo.test.ts", files: ["test/foo.test.ts", "test/bar.test.ts"], reasonDetail: "needs mock restructure" },
      ]);
      strategy.extractApplied!(output, [], {} as FixCycleContext);
      expect(sink.mockHandoffs).toHaveLength(1);
      expect(sink.mockHandoffs[0]).toEqual({ files: ["test/foo.test.ts", "test/bar.test.ts"], reasonDetail: "needs mock restructure" });
      expect(sink.testEdits).toHaveLength(0);
    });

    test("pushes non-mock_structure declarations to sink.testEdits", () => {
      const sink = makeSink();
      const strategy = makeAutofixImplementerStrategy(makeStory(), makeNaxConfig(), sink);
      const lintDecl = { reason: "lint_only" as const, file: "test/foo.test.ts", finding: "some lint" };
      const prdDecl = { reason: "prd_contract" as const, file: "test/bar.test.ts" };
      const output = makeOutput([lintDecl, prdDecl]);
      strategy.extractApplied!(output, [], {} as FixCycleContext);
      expect(sink.testEdits).toHaveLength(2);
      expect(sink.mockHandoffs).toHaveLength(0);
    });

    test("with empty declarations: sink unchanged", () => {
      const sink = makeSink();
      const strategy = makeAutofixImplementerStrategy(makeStory(), makeNaxConfig(), sink);
      const output = makeOutput([]);
      strategy.extractApplied!(output, [], {} as FixCycleContext);
      expect(sink.testEdits).toHaveLength(0);
      expect(sink.mockHandoffs).toHaveLength(0);
    });

    test("returns summary from unresolvedReason", () => {
      const sink = makeSink();
      const strategy = makeAutofixImplementerStrategy(makeStory(), makeNaxConfig(), sink);
      const output = makeOutput([], "reviewer contradiction");
      const result = strategy.extractApplied!(output, [], {} as FixCycleContext);
      expect(result.summary).toBe("reviewer contradiction");
      expect(result.unresolved).toBe("reviewer contradiction");
    });

    test("returns empty summary when no unresolvedReason", () => {
      const sink = makeSink();
      const strategy = makeAutofixImplementerStrategy(makeStory(), makeNaxConfig(), sink);
      const output = makeOutput([]);
      const result = strategy.extractApplied!(output, [], {} as FixCycleContext);
      expect(result.summary).toBe("");
      expect(result.unresolved).toBeUndefined();
    });

    test("partitions mixed declarations correctly", () => {
      const sink = makeSink();
      const strategy = makeAutofixImplementerStrategy(makeStory(), makeNaxConfig(), sink);
      const output = makeOutput([
        { reason: "mock_structure", file: "test/a.test.ts", files: ["test/a.test.ts"], reasonDetail: "mock reason" },
        { reason: "lint_only", file: "test/b.test.ts", finding: "lint error" },
        { reason: "mock_structure", file: "test/c.test.ts", files: ["test/c.test.ts"], reasonDetail: "another mock reason" },
        { reason: "prd_contract", file: "test/d.test.ts" },
      ]);
      strategy.extractApplied!(output, [], {} as FixCycleContext);
      expect(sink.mockHandoffs).toHaveLength(2);
      expect(sink.testEdits).toHaveLength(2);
    });
  });
});
