import { describe, expect, test } from "bun:test";
import type { Finding } from "@/findings";
import { makeAutofixImplementerStrategy } from "@/operations";

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

describe("makeAutofixImplementerStrategy", () => {
  test("name is autofix-implementer", () => {
    const strategy = makeAutofixImplementerStrategy(mockCtx);
    expect(strategy.name).toBe("autofix-implementer");
  });

  test("fixOp name is autofix-implementer", () => {
    const strategy = makeAutofixImplementerStrategy(mockCtx);
    expect(strategy.fixOp.name).toBe("autofix-implementer");
  });

  test("maxAttempts is a positive number", () => {
    const strategy = makeAutofixImplementerStrategy(mockCtx);
    expect(strategy.maxAttempts).toBeGreaterThan(0);
  });

  describe("AC3: appliesTo predicate — source includes list", () => {
    test("AC3: returns true when fixTarget=source and source=lint", () => {
      const strategy = makeAutofixImplementerStrategy(mockCtx);
      const finding = makeFinding({ fixTarget: "source", source: "lint" });
      expect(strategy.appliesTo(finding)).toBe(true);
    });

    test("AC3: returns true when fixTarget=source and source=typecheck", () => {
      const strategy = makeAutofixImplementerStrategy(mockCtx);
      const finding = makeFinding({ fixTarget: "source", source: "typecheck" });
      expect(strategy.appliesTo(finding)).toBe(true);
    });

    test("AC3: returns true when fixTarget=source and source=semantic-review", () => {
      const strategy = makeAutofixImplementerStrategy(mockCtx);
      const finding = makeFinding({ fixTarget: "source", source: "semantic-review" });
      expect(strategy.appliesTo(finding)).toBe(true);
    });

    test("AC3: returns false when fixTarget=test", () => {
      const strategy = makeAutofixImplementerStrategy(mockCtx);
      const finding = makeFinding({ fixTarget: "test", source: "lint" });
      expect(strategy.appliesTo(finding)).toBe(false);
    });

    test("AC3: returns false when source=test-runner", () => {
      const strategy = makeAutofixImplementerStrategy(mockCtx);
      const finding = makeFinding({ fixTarget: "source", source: "test-runner" });
      expect(strategy.appliesTo(finding)).toBe(false);
    });

    test("AC3: returns false when source is not in allowed list (adversarial-review with fixTarget=source)", () => {
      const strategy = makeAutofixImplementerStrategy(mockCtx);
      const finding = makeFinding({ fixTarget: "source", source: "adversarial-review" });
      expect(strategy.appliesTo(finding)).toBe(false);
    });
  });
});
