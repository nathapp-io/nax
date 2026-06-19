import { describe, expect, test } from "bun:test";
import { fullSuiteRectifyOp } from "@/operations";
import { RectifierPromptBuilder } from "@/prompts";
import type { Finding } from "@/findings/types";
import { makeStory } from "@test/helpers";

const finding: Finding = {
  source: "test-runner",
  severity: "error",
  category: "failed-test",
  rule: "should work",
  file: "test/unit/foo.test.ts",
  message: "AssertionError: expected true to be false",
};

const story = makeStory({
  routing: { testStrategy: "three-session-tdd", complexity: "medium", reasoning: "tdd" },
});

// biome-ignore lint/suspicious/noExplicitAny: ctx stubs for unit tests
const ctx = { story } as any;

describe("fullSuiteRectifyOp — shape (AC-1)", () => {
  test("kind is 'run'", () => {
    expect(fullSuiteRectifyOp.kind).toBe("run");
  });

  test("name is 'full-suite-rectify'", () => {
    expect(fullSuiteRectifyOp.name).toBe("full-suite-rectify");
  });

  test("stage is 'rectification'", () => {
    expect(fullSuiteRectifyOp.stage).toBe("rectification");
  });

  test("session role is 'implementer' and lifetime is 'warm'", () => {
    expect(fullSuiteRectifyOp.session.role).toBe("implementer");
    expect(fullSuiteRectifyOp.session.lifetime).toBe("warm");
  });
});

describe("fullSuiteRectifyOp.build (AC-2)", () => {
  test("task content equals RectifierPromptBuilder.failingTestRectification", () => {
    const result = fullSuiteRectifyOp.build({ story, findings: [finding] }, ctx);
    const expected = RectifierPromptBuilder.failingTestRectification([finding], story);
    expect(result.task.content).toBe(expected);
  });

  test("task content contains TEST_EDIT_REASON", () => {
    const result = fullSuiteRectifyOp.build({ story, findings: [finding] }, ctx);
    expect(result.task.content).toContain("TEST_EDIT_REASON");
  });
});

describe("fullSuiteRectifyOp.parse (AC-3)", () => {
  const input = { story, findings: [finding] };

  test("mock_structure block yields applied=true with parsed declaration", () => {
    const output = `Fixed the mock.

TEST_EDIT_REASON: mock_structure
FILES: test/unit/foo.test.ts, test/unit/bar.test.ts
REASON: The mock structure was incompatible with the updated API surface.`;

    const result = fullSuiteRectifyOp.parse(output, input, ctx);
    expect(result.applied).toBe(true);
    expect(result.testEditDeclarations).toHaveLength(1);
    expect(result.testEditDeclarations[0].reason).toBe("mock_structure");
    expect(result.testEditDeclarations[0].files).toContain("test/unit/foo.test.ts");
  });
});

describe("fullSuiteRectifyOp.parse (AC-4)", () => {
  const input = { story, findings: [finding] };

  test("no TEST_EDIT_REASON block yields applied=true and empty declarations", () => {
    const result = fullSuiteRectifyOp.parse("Fixed the implementation.", input, ctx);
    expect(result.applied).toBe(true);
    expect(result.testEditDeclarations).toEqual([]);
  });
});

describe("fullSuiteRectifyOp.parse — UNRESOLVED sentinel (AC-5)", () => {
  const input = { story, findings: [finding] };

  test("UNRESOLVED: line sets unresolvedReason", () => {
    const output =
      "Tried several approaches.\n\nUNRESOLVED: The test passes relative URLs that the library rejects — cannot satisfy without modifying the test.";
    const result = fullSuiteRectifyOp.parse(output, input, ctx);
    expect(result.unresolvedReason).toBe(
      "The test passes relative URLs that the library rejects — cannot satisfy without modifying the test.",
    );
  });

  test("output without UNRESOLVED: leaves unresolvedReason undefined", () => {
    const result = fullSuiteRectifyOp.parse("Fixed everything.", input, ctx);
    expect(result.unresolvedReason).toBeUndefined();
  });

  test("UNRESOLVED: coexists with test-edit declarations", () => {
    const output = `TEST_EDIT_REASON: lint_only
FILE: test/unit/foo.test.ts
FINDING: no-unused-vars
CHANGE: const x = 1; → // removed

UNRESOLVED: AC6 cannot be satisfied without changing the assertion.`;
    const result = fullSuiteRectifyOp.parse(output, input, ctx);
    expect(result.testEditDeclarations).toHaveLength(1);
    expect(result.unresolvedReason).toBe("AC6 cannot be satisfied without changing the assertion.");
  });
});
