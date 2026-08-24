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

  describe("single-session: includeAdversarialReview opt-in", () => {
    test("claims adversarial-review findings (fixTarget undefined) when includeAdversarialReview=true", () => {
      const strategy = makeAutofixImplementerStrategy(mockCtx, makeNaxConfig(), makeSink(), {
        includeAdversarialReview: true,
      });
      const finding = makeFinding({ fixTarget: undefined, source: "adversarial-review" });
      expect(strategy.appliesTo(finding)).toBe(true);
    });

    test("claims adversarial-review test-gap findings (fixTarget=test) when includeAdversarialReview=true", () => {
      const strategy = makeAutofixImplementerStrategy(mockCtx, makeNaxConfig(), makeSink(), {
        includeAdversarialReview: true,
      });
      const finding = makeFinding({ fixTarget: "test", source: "adversarial-review" });
      expect(strategy.appliesTo(finding)).toBe(true);
    });

    test("does NOT claim adversarial-review findings by default (three-session)", () => {
      const strategy = makeAutofixImplementerStrategy(mockCtx, makeNaxConfig(), makeSink());
      const finding = makeFinding({ fixTarget: undefined, source: "adversarial-review" });
      expect(strategy.appliesTo(finding)).toBe(false);
    });

    test("still claims semantic-review source findings when includeAdversarialReview=true", () => {
      const strategy = makeAutofixImplementerStrategy(mockCtx, makeNaxConfig(), makeSink(), {
        includeAdversarialReview: true,
      });
      const finding = makeFinding({ fixTarget: "source", source: "semantic-review" });
      expect(strategy.appliesTo(finding)).toBe(true);
    });

    test("does not claim unrelated test-runner findings even when includeAdversarialReview=true", () => {
      const strategy = makeAutofixImplementerStrategy(mockCtx, makeNaxConfig(), makeSink(), {
        includeAdversarialReview: true,
      });
      const finding = makeFinding({ fixTarget: "test", source: "test-runner" });
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

  test("buildInput omits blockingThreshold by default (inherits run threshold)", () => {
    const strategy = makeAutofixImplementerStrategy(makeStory(), makeNaxConfig(), makeSink());
    const input = strategy.buildInput([], [], {} as FixCycleContext);
    // config.review.blockingThreshold defaults to "error".
    expect(input.blockingThreshold).toBe("error");
  });

  test("promptSeverityFloor=info sets blockingThreshold so advisory findings render (non-blocking fix)", () => {
    const strategy = makeAutofixImplementerStrategy(makeStory(), makeNaxConfig(), makeSink(), {
      adversarialReviewByFixTarget: "source",
      promptSeverityFloor: "info",
    });
    const input = strategy.buildInput([], [], {} as FixCycleContext);
    expect(input.blockingThreshold).toBe("info");
  });

  describe("triage: adversarialReviewByFixTarget opt-in", () => {
    test("claims adversarial-review with fixTarget=source when adversarialReviewByFixTarget='source'", () => {
      const strategy = makeAutofixImplementerStrategy(mockCtx, makeNaxConfig(), makeSink(), {
        adversarialReviewByFixTarget: "source",
      });
      const finding = makeFinding({ fixTarget: "source", source: "adversarial-review" });
      expect(strategy.appliesTo(finding)).toBe(true);
    });

    test("does NOT claim adversarial-review with fixTarget=test when adversarialReviewByFixTarget='source'", () => {
      const strategy = makeAutofixImplementerStrategy(mockCtx, makeNaxConfig(), makeSink(), {
        adversarialReviewByFixTarget: "source",
      });
      const finding = makeFinding({ fixTarget: "test", source: "adversarial-review" });
      expect(strategy.appliesTo(finding)).toBe(false);
    });

    test("does NOT claim adversarial-review with fixTarget=undefined when adversarialReviewByFixTarget='source'", () => {
      const strategy = makeAutofixImplementerStrategy(mockCtx, makeNaxConfig(), makeSink(), {
        adversarialReviewByFixTarget: "source",
      });
      const finding = makeFinding({ fixTarget: undefined, source: "adversarial-review" });
      expect(strategy.appliesTo(finding)).toBe(false);
    });

    test("default opts do NOT claim any adversarial findings (adversarialReviewByFixTarget unset)", () => {
      const strategy = makeAutofixImplementerStrategy(mockCtx, makeNaxConfig(), makeSink());
      const finding = makeFinding({ fixTarget: "source", source: "adversarial-review" });
      expect(strategy.appliesTo(finding)).toBe(false);
    });

    test("AC6: three-session default (no opts) does NOT claim adversarial source findings", () => {
      const strategy = makeAutofixImplementerStrategy(mockCtx, makeNaxConfig(), makeSink());
      const finding = makeFinding({ fixTarget: "source", source: "adversarial-review" });
      expect(strategy.appliesTo(finding)).toBe(false);
    });

    test("still claims IMPLEMENTER_SOURCES source findings when adversarialReviewByFixTarget='source'", () => {
      const strategy = makeAutofixImplementerStrategy(mockCtx, makeNaxConfig(), makeSink(), {
        adversarialReviewByFixTarget: "source",
      });
      const finding = makeFinding({ fixTarget: "source", source: "lint" });
      expect(strategy.appliesTo(finding)).toBe(true);
    });

    test("does NOT claim adversarial findings with fixTarget=test even alongside includeAdversarialReview=true", () => {
      // AC3 routing: even with the blanket opt-in, the test-targeted adversarial
      // finding must NOT be claimed by the implementer (it's the test-writer's lane).
      const strategy = makeAutofixImplementerStrategy(mockCtx, makeNaxConfig(), makeSink(), {
        includeAdversarialReview: true,
        adversarialReviewByFixTarget: "source",
      });
      const finding = makeFinding({ fixTarget: "test", source: "adversarial-review" });
      expect(strategy.appliesTo(finding)).toBe(false);
    });
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
      const input = strategy.buildInput([], [], {} as FixCycleContext);
      const output = makeOutput([
        {
          reason: "mock_structure",
          file: "test/foo.test.ts",
          files: ["test/foo.test.ts", "test/bar.test.ts"],
          reasonDetail: "needs mock restructure",
        },
      ]);
      strategy.extractApplied!(output, input);
      expect(sink.mockHandoffs).toHaveLength(1);
      expect(sink.mockHandoffs[0]).toEqual({
        files: ["test/foo.test.ts", "test/bar.test.ts"],
        reasonDetail: "needs mock restructure",
      });
      expect(sink.testEdits).toHaveLength(0);
    });

    test("pushes non-mock_structure declarations to sink.testEdits", () => {
      const sink = makeSink();
      const strategy = makeAutofixImplementerStrategy(makeStory(), makeNaxConfig(), sink);
      const input = strategy.buildInput([], [], {} as FixCycleContext);
      const lintDecl = { reason: "lint_only" as const, file: "test/foo.test.ts", finding: "some lint" };
      const prdDecl = { reason: "prd_contract" as const, file: "test/bar.test.ts" };
      const output = makeOutput([lintDecl, prdDecl]);
      strategy.extractApplied!(output, input);
      expect(sink.testEdits).toHaveLength(2);
      expect(sink.mockHandoffs).toHaveLength(0);
    });

    test("with empty declarations: sink unchanged", () => {
      const sink = makeSink();
      const strategy = makeAutofixImplementerStrategy(makeStory(), makeNaxConfig(), sink);
      const input = strategy.buildInput([], [], {} as FixCycleContext);
      const output = makeOutput([]);
      strategy.extractApplied!(output, input);
      expect(sink.testEdits).toHaveLength(0);
      expect(sink.mockHandoffs).toHaveLength(0);
    });

    test("returns summary from unresolvedReason", async () => {
      const sink = makeSink();
      const strategy = makeAutofixImplementerStrategy(makeStory(), makeNaxConfig(), sink);
      const input = strategy.buildInput([], [], {} as FixCycleContext);
      const output = makeOutput([], "reviewer contradiction");
      const result = await strategy.extractApplied!(output, input);
      expect(result.summary).toBe("reviewer contradiction");
      expect(result.unresolved).toBe("reviewer contradiction");
    });

    test("returns empty summary when no unresolvedReason", async () => {
      const sink = makeSink();
      const strategy = makeAutofixImplementerStrategy(makeStory(), makeNaxConfig(), sink);
      const input = strategy.buildInput([], [], {} as FixCycleContext);
      const output = makeOutput([]);
      const result = await strategy.extractApplied!(output, input);
      expect(result.summary).toBe("");
      expect(result.unresolved).toBeUndefined();
    });

    test("partitions mixed declarations correctly", () => {
      const sink = makeSink();
      const strategy = makeAutofixImplementerStrategy(makeStory(), makeNaxConfig(), sink);
      const input = strategy.buildInput([], [], {} as FixCycleContext);
      const output = makeOutput([
        { reason: "mock_structure", file: "test/a.test.ts", files: ["test/a.test.ts"], reasonDetail: "mock reason" },
        { reason: "lint_only", file: "test/b.test.ts", finding: "lint error" },
        {
          reason: "mock_structure",
          file: "test/c.test.ts",
          files: ["test/c.test.ts"],
          reasonDetail: "another mock reason",
        },
        { reason: "prd_contract", file: "test/d.test.ts" },
      ]);
      strategy.extractApplied!(output, input);
      expect(sink.mockHandoffs).toHaveLength(2);
      expect(sink.testEdits).toHaveLength(2);
    });
  });
});
