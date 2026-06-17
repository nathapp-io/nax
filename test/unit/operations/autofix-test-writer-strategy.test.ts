import { describe, expect, test } from "bun:test";
import type { Finding } from "@/findings";
import type { FixCycleContext } from "@/findings/cycle-types";
import { makeAutofixTestWriterStrategy, makeDeclarationSink } from "@/operations";
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

describe("makeAutofixTestWriterStrategy", () => {
  test("name is autofix-test-writer", () => {
    const strategy = makeAutofixTestWriterStrategy(mockCtx, makeNaxConfig(), makeSink());
    expect(strategy.name).toBe("autofix-test-writer");
  });

  test("fixOp name is autofix-test-writer", () => {
    const strategy = makeAutofixTestWriterStrategy(mockCtx, makeNaxConfig(), makeSink());
    expect(strategy.fixOp.name).toBe("autofix-test-writer");
  });

  test("maxAttempts is a positive number", () => {
    const strategy = makeAutofixTestWriterStrategy(mockCtx, makeNaxConfig(), makeSink());
    expect(strategy.maxAttempts).toBeGreaterThan(0);
  });

  describe("AC4: appliesTo predicate — test-targeted findings", () => {
    test("AC4: returns true when fixTarget=test", () => {
      const strategy = makeAutofixTestWriterStrategy(mockCtx, makeNaxConfig(), makeSink());
      const finding = makeFinding({ fixTarget: "test", source: "lint" });
      expect(strategy.appliesTo(finding)).toBe(true);
    });

    test("AC4: returns true when source=adversarial-review", () => {
      const strategy = makeAutofixTestWriterStrategy(mockCtx, makeNaxConfig(), makeSink());
      const finding = makeFinding({ fixTarget: "source", source: "adversarial-review" });
      expect(strategy.appliesTo(finding)).toBe(true);
    });

    test("AC4: returns true when fixTarget=test and source=adversarial-review", () => {
      const strategy = makeAutofixTestWriterStrategy(mockCtx, makeNaxConfig(), makeSink());
      const finding = makeFinding({ fixTarget: "test", source: "adversarial-review" });
      expect(strategy.appliesTo(finding)).toBe(true);
    });

    test("AC4: returns false when fixTarget=source and source is not adversarial-review (lint)", () => {
      const strategy = makeAutofixTestWriterStrategy(mockCtx, makeNaxConfig(), makeSink());
      const finding = makeFinding({ fixTarget: "source", source: "lint" });
      expect(strategy.appliesTo(finding)).toBe(false);
    });

    test("AC4: returns false when fixTarget=source and source=typecheck", () => {
      const strategy = makeAutofixTestWriterStrategy(mockCtx, makeNaxConfig(), makeSink());
      const finding = makeFinding({ fixTarget: "source", source: "typecheck" });
      expect(strategy.appliesTo(finding)).toBe(false);
    });

    test("AC4: returns false when fixTarget=source and source=semantic-review", () => {
      const strategy = makeAutofixTestWriterStrategy(mockCtx, makeNaxConfig(), makeSink());
      const finding = makeFinding({ fixTarget: "source", source: "semantic-review" });
      expect(strategy.appliesTo(finding)).toBe(false);
    });

    test("AC4: returns true when sink.mockHandoffs is non-empty (even source finding)", () => {
      const sink = makeSink();
      sink.mockHandoffs.push({ files: ["test/foo.test.ts"], reasonDetail: "mock reason" });
      const strategy = makeAutofixTestWriterStrategy(mockCtx, makeNaxConfig(), sink);
      // A source finding that would normally not match
      const finding = makeFinding({ fixTarget: "source", source: "lint" });
      expect(strategy.appliesTo(finding)).toBe(true);
    });
  });

  test("AC2.4: buildInput converts adversarial finding to ReviewCheckResult", () => {
    const story = makeStory();
    const config = makeNaxConfig();
    const strategy = makeAutofixTestWriterStrategy(story, config, makeSink());
    const adversarialFinding: Finding = {
      source: "adversarial-review",
      severity: "error",
      category: "",
      message: "Coverage gap",
      file: "test/foo.test.ts",
      line: 3,
    };
    const input = strategy.buildInput([adversarialFinding], [], {} as FixCycleContext);
    expect(input.failedChecks).toHaveLength(1);
    expect(input.failedChecks[0]?.check).toBe("adversarial");
    expect(input.failedChecks[0]?.findings).toEqual([adversarialFinding]);
  });

  describe("triage: disableBlanketAdversarial opt-in", () => {
    test("AC5: default opts still claim adversarial source finding (blanket behaviour preserved)", () => {
      const strategy = makeAutofixTestWriterStrategy(mockCtx, makeNaxConfig(), makeSink());
      const finding = makeFinding({ fixTarget: "source", source: "adversarial-review" });
      expect(strategy.appliesTo(finding)).toBe(true);
    });

    test("does NOT claim adversarial source finding when disableBlanketAdversarial=true", () => {
      const strategy = makeAutofixTestWriterStrategy(mockCtx, makeNaxConfig(), makeSink(), {
        disableBlanketAdversarial: true,
      });
      const finding = makeFinding({ fixTarget: "source", source: "adversarial-review" });
      expect(strategy.appliesTo(finding)).toBe(false);
    });

    test("still claims adversarial test finding when disableBlanketAdversarial=true", () => {
      const strategy = makeAutofixTestWriterStrategy(mockCtx, makeNaxConfig(), makeSink(), {
        disableBlanketAdversarial: true,
      });
      const finding = makeFinding({ fixTarget: "test", source: "adversarial-review" });
      expect(strategy.appliesTo(finding)).toBe(true);
    });

    test("AC4: still claims convention test finding when disableBlanketAdversarial=true", () => {
      const strategy = makeAutofixTestWriterStrategy(mockCtx, makeNaxConfig(), makeSink(), {
        disableBlanketAdversarial: true,
      });
      const finding = makeFinding({
        fixTarget: "test",
        source: "adversarial-review",
        category: "convention",
      });
      expect(strategy.appliesTo(finding)).toBe(true);
    });

    test("still claims mockHandoffs when disableBlanketAdversarial=true", () => {
      const sink = makeSink();
      sink.mockHandoffs.push({ files: ["test/foo.test.ts"], reasonDetail: "mock reason" });
      const strategy = makeAutofixTestWriterStrategy(mockCtx, makeNaxConfig(), sink, {
        disableBlanketAdversarial: true,
      });
      const finding = makeFinding({ fixTarget: "source", source: "lint" });
      expect(strategy.appliesTo(finding)).toBe(true);
    });

    test("does NOT claim lint source finding when disableBlanketAdversarial=true and no mockHandoffs", () => {
      const strategy = makeAutofixTestWriterStrategy(mockCtx, makeNaxConfig(), makeSink(), {
        disableBlanketAdversarial: true,
      });
      const finding = makeFinding({ fixTarget: "source", source: "lint" });
      expect(strategy.appliesTo(finding)).toBe(false);
    });
  });

  describe("buildInput — mock-restructure mode", () => {
    test("returns mode=mock-restructure when sink.mockHandoffs is populated", () => {
      const sink = makeSink();
      sink.mockHandoffs.push({ files: ["test/foo.test.ts", "test/bar.test.ts"], reasonDetail: "mock reason A" });
      const strategy = makeAutofixTestWriterStrategy(makeStory(), makeNaxConfig(), sink);
      const input = strategy.buildInput([], [], {} as FixCycleContext);
      expect(input.mode).toBe("mock-restructure");
    });

    test("dedupes files across all handoff entries", () => {
      const sink = makeSink();
      sink.mockHandoffs.push({ files: ["test/foo.test.ts", "test/shared.test.ts"], reasonDetail: "reason A" });
      sink.mockHandoffs.push({ files: ["test/bar.test.ts", "test/shared.test.ts"], reasonDetail: "reason B" });
      const strategy = makeAutofixTestWriterStrategy(makeStory(), makeNaxConfig(), sink);
      const input = strategy.buildInput([], [], {} as FixCycleContext);
      expect(input.handoffFiles).toBeDefined();
      const files = input.handoffFiles!;
      const unique = new Set(files);
      expect(files.length).toBe(unique.size);
      expect(files).toContain("test/foo.test.ts");
      expect(files).toContain("test/bar.test.ts");
      expect(files).toContain("test/shared.test.ts");
    });

    test("joins reasonDetail with newline separator", () => {
      const sink = makeSink();
      sink.mockHandoffs.push({ files: ["test/a.test.ts"], reasonDetail: "reason A" });
      sink.mockHandoffs.push({ files: ["test/b.test.ts"], reasonDetail: "reason B" });
      const strategy = makeAutofixTestWriterStrategy(makeStory(), makeNaxConfig(), sink);
      const input = strategy.buildInput([], [], {} as FixCycleContext);
      expect(input.handoffReason).toBe("reason A\n---\nreason B");
    });

    test("clears sink.mockHandoffs after draining", () => {
      const sink = makeSink();
      sink.mockHandoffs.push({ files: ["test/foo.test.ts"], reasonDetail: "reason" });
      const strategy = makeAutofixTestWriterStrategy(makeStory(), makeNaxConfig(), sink);
      strategy.buildInput([], [], {} as FixCycleContext);
      expect(sink.mockHandoffs).toHaveLength(0);
    });

    test("uses default mode when sink is empty", () => {
      const sink = makeSink();
      const strategy = makeAutofixTestWriterStrategy(makeStory(), makeNaxConfig(), sink);
      const input = strategy.buildInput([], [], {} as FixCycleContext);
      expect(input.mode).toBeUndefined();
      expect(input.handoffFiles).toBeUndefined();
      expect(input.handoffReason).toBeUndefined();
    });
  });
});
