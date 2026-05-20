import { describe, expect, test } from "bun:test";
import { fullSuiteRectifyStrategy } from "@/operations";
import type { Finding } from "@/findings";

function makeTestFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    source: "test-runner",
    severity: "error",
    category: "failed-test",
    rule: "some test",
    file: "test/unit/foo.test.ts",
    message: "Expected true but got false",
    ...overrides,
  };
}

describe("fullSuiteRectifyStrategy", () => {
  test("name is full-suite-rectify", () => {
    expect(fullSuiteRectifyStrategy.name).toBe("full-suite-rectify");
  });

  test("coRun is exclusive", () => {
    expect(fullSuiteRectifyStrategy.coRun).toBe("exclusive");
  });

  test("appliesTo returns true for test-runner + failed-test findings", () => {
    const finding = makeTestFinding();
    expect(fullSuiteRectifyStrategy.appliesTo(finding)).toBe(true);
  });

  test("appliesTo returns false for other sources", () => {
    const finding = makeTestFinding({ source: "lint" });
    expect(fullSuiteRectifyStrategy.appliesTo(finding)).toBe(false);
  });

  test("appliesTo returns false for other categories (e.g. assertion-failure from acceptance-diagnose)", () => {
    const finding = makeTestFinding({ category: "assertion-failure" });
    expect(fullSuiteRectifyStrategy.appliesTo(finding)).toBe(false);
  });

  test("fixOp references implementerOp (name=implementer)", () => {
    expect(fullSuiteRectifyStrategy.fixOp.name).toBe("implementer");
  });

  test("buildInput produces ImplementerInput with story and contextMarkdown", () => {
    const finding = makeTestFinding();
    const ctx = { storyId: "US-001", story: { id: "US-001", title: "Test" } } as any;
    const input = fullSuiteRectifyStrategy.buildInput([finding], [], ctx);
    expect(input.story).toBeDefined();
    expect(typeof input.contextMarkdown).toBe("string");
    expect(input.contextMarkdown!.length).toBeGreaterThan(0);
  });
});
