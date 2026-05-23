import { describe, expect, test } from "bun:test";
import type { Finding } from "@/findings";
import { makeAutofixTestWriterStrategy } from "@/operations";

const mockCtx = {} as any;

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
    const strategy = makeAutofixTestWriterStrategy(mockCtx);
    expect(strategy.name).toBe("autofix-test-writer");
  });

  test("fixOp name is autofix-test-writer", () => {
    const strategy = makeAutofixTestWriterStrategy(mockCtx);
    expect(strategy.fixOp.name).toBe("autofix-test-writer");
  });

  test("maxAttempts is a positive number", () => {
    const strategy = makeAutofixTestWriterStrategy(mockCtx);
    expect(strategy.maxAttempts).toBeGreaterThan(0);
  });

  describe("AC4: appliesTo predicate — test-targeted findings", () => {
    test("AC4: returns true when fixTarget=test", () => {
      const strategy = makeAutofixTestWriterStrategy(mockCtx);
      const finding = makeFinding({ fixTarget: "test", source: "lint" });
      expect(strategy.appliesTo(finding)).toBe(true);
    });

    test("AC4: returns true when source=adversarial-review", () => {
      const strategy = makeAutofixTestWriterStrategy(mockCtx);
      const finding = makeFinding({ fixTarget: "source", source: "adversarial-review" });
      expect(strategy.appliesTo(finding)).toBe(true);
    });

    test("AC4: returns true when fixTarget=test and source=adversarial-review", () => {
      const strategy = makeAutofixTestWriterStrategy(mockCtx);
      const finding = makeFinding({ fixTarget: "test", source: "adversarial-review" });
      expect(strategy.appliesTo(finding)).toBe(true);
    });

    test("AC4: returns false when fixTarget=source and source is not adversarial-review (lint)", () => {
      const strategy = makeAutofixTestWriterStrategy(mockCtx);
      const finding = makeFinding({ fixTarget: "source", source: "lint" });
      expect(strategy.appliesTo(finding)).toBe(false);
    });

    test("AC4: returns false when fixTarget=source and source=typecheck", () => {
      const strategy = makeAutofixTestWriterStrategy(mockCtx);
      const finding = makeFinding({ fixTarget: "source", source: "typecheck" });
      expect(strategy.appliesTo(finding)).toBe(false);
    });

    test("AC4: returns false when fixTarget=source and source=semantic-review", () => {
      const strategy = makeAutofixTestWriterStrategy(mockCtx);
      const finding = makeFinding({ fixTarget: "source", source: "semantic-review" });
      expect(strategy.appliesTo(finding)).toBe(false);
    });
  });
});
