import { describe, expect, test } from "bun:test";
import { makeStory, makeTestRuntime } from "@test/helpers";
import { autofixConfigSelector } from "@/config";
import type { AutofixConfig } from "@/config/selectors";
import type { Finding } from "@/findings/types";
import { fullSuiteRectifyOp } from "@/operations";
import type { BuildContext } from "@/operations/types";
import { RectifierPromptBuilder, repoScopedRectification } from "@/prompts";

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

// The op's build/parse/keepOpen never read the context — it only needs to
// satisfy BuildContext<AutofixConfig>, which the real runtime's package view does.
function makeCtx(): BuildContext<AutofixConfig> {
  const view = makeTestRuntime().packages.repo();
  return { packageView: view, config: view.select(autofixConfigSelector) };
}

const ctx = makeCtx();

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

// ─── Repo-scoped dispatch (#1654) ────────────────────────────────────────────
//
// The same op serves both the story-scoped rectifier and the repo-scoped
// regression fixer; only the mandate differs. Sharing the op keeps one
// UNRESOLVED protocol and one declaration parser across both dispatches.

describe("fullSuiteRectifyOp.build — scope: 'repo'", () => {
  test("uses the repo-scoped mandate, not the story-scoped one", () => {
    const result = fullSuiteRectifyOp.build({ story, findings: [finding], scope: "repo" }, ctx);
    expect(result.task.content).toBe(repoScopedRectification([finding], story));
    expect(result.task.content).not.toBe(RectifierPromptBuilder.failingTestRectification([finding], story));
  });

  test("omitting scope keeps the story-scoped prompt byte-identical", () => {
    const withoutScope = fullSuiteRectifyOp.build({ story, findings: [finding] }, ctx);
    const withStoryScope = fullSuiteRectifyOp.build({ story, findings: [finding], scope: "story" }, ctx);
    const expected = RectifierPromptBuilder.failingTestRectification([finding], story);
    expect(withoutScope.task.content).toBe(expected);
    expect(withStoryScope.task.content).toBe(expected);
  });

  test("still carries the test-edit declaration protocol", () => {
    // Lifting the scope constraint must not lift the test-integrity rules — an
    // agent free to touch any file is exactly the one that must not be free to
    // delete the failing assertion.
    const result = fullSuiteRectifyOp.build({ story, findings: [finding], scope: "repo" }, ctx);
    expect(result.task.content).toContain("TEST_EDIT_REASON");
  });
});

describe("fullSuiteRectifyOp.keepOpen — scope: 'repo'", () => {
  test("repo scope does not keep the session open", () => {
    // The repo-scoped dispatch runs under its own session role and gets one
    // attempt; leaving it warm would strand a session nothing resumes.
    expect(fullSuiteRectifyOp.keepOpen?.({ story, findings: [finding], scope: "repo" }, ctx)).toBe(false);
  });

  test("story scope keeps the warm session the op declares", () => {
    expect(fullSuiteRectifyOp.keepOpen?.({ story, findings: [finding] }, ctx)).toBe(true);
  });
});
