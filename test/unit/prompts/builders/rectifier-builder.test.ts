/**
 * Unit tests for RectifierPromptBuilder.continuation (PROMPT-001).
 *
 * Tests cover:
 * 1. Continuation prompt contains error output from failedChecks
 * 2. Continuation prompt contains findings when present
 * 3. Rethink preamble appears at rethinkAtAttempt
 * 4. Urgency preamble appears at urgencyAtAttempt
 * 5. CONTRADICTION_ESCAPE_HATCH is present in every continuation prompt
 * 6. Continuation prompt does NOT contain "constitution", "acceptance criteria", "story"
 *    (i.e. it is minimal — not the full prompt)
 */

import { describe, expect, test } from "bun:test";
import type { Finding } from "@/findings";
import { RectifierPromptBuilder } from "@/prompts";
import type { ReviewCheckResult } from "@/review";
import { makeStory } from "@test/helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCheck(check: string, output: string, exitCode = 1): ReviewCheckResult {
  return {
    check: check as ReviewCheckResult["check"],
    success: false,
    command: `${check}-cmd`,
    exitCode,
    output,
    durationMs: 100,
  };
}

function makeCheckWithFindings(check: string, output: string): ReviewCheckResult {
  return {
    ...makeCheck(check, output),
    findings: [
      {
        ruleId: "semantic",
        severity: "error",
        file: "src/foo.ts",
        line: 42,
        message: "Missing implementation for AC-1",
        source: "semantic-review",
      },
    ],
  };
}

const DEFAULTS = {
  attempt: 1,
  rethinkAtAttempt: 2,
  urgencyAtAttempt: 3,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RectifierPromptBuilder.firstAttemptDelta", () => {
  test("contains failed check output, check name/exit code, UNRESOLVED/fix instructions, excludes story sections, handles multiple checks", () => {
    const checks = [makeCheck("lint", "lint error output"), makeCheck("typecheck", "typecheck error output")];
    const prompt = RectifierPromptBuilder.firstAttemptDelta(checks, 2);
    // Content
    expect(prompt).toContain("lint error output");
    expect(prompt).toContain("typecheck error output");
    expect(prompt).toContain("### lint");
    expect(prompt).toContain("### typecheck");
    // Single-check header format with exit code
    const singlePrompt = RectifierPromptBuilder.firstAttemptDelta(
      [makeCheck("typecheck", "Unexpected token at line 10", 2)],
      2,
    );
    expect(singlePrompt).toContain("Unexpected token at line 10");
    expect(singlePrompt).toContain("### typecheck (exit 2)");
    // UNRESOLVED + fix instructions + exclusions
    const fixPrompt = RectifierPromptBuilder.firstAttemptDelta([makeCheck("lint", "error")], 2);
    expect(fixPrompt).toContain("UNRESOLVED:");
    expect(fixPrompt).toContain("Fix in priority order");
    expect(fixPrompt).toContain("re-run the failing check(s) at that level to verify they pass before moving on");
    expect(fixPrompt).toContain("Commit your changes when all checks pass");
    expect(fixPrompt.toLowerCase()).not.toContain("### acceptance criteria");
    expect(fixPrompt).not.toMatch(/^Story:/m);
    expect(fixPrompt.toLowerCase()).not.toContain("constitution");
  });

  test.each([
    [1, "1 attempt", "1 attempts"],
    [3, "3 attempts", null],
  ] as const)("maxAttempts=%s uses correct plural form", (maxAttempts, shouldContain, shouldNotContain) => {
    const prompt = RectifierPromptBuilder.firstAttemptDelta([makeCheck("lint", "error")], maxAttempts);
    expect(prompt).toContain(shouldContain);
    if (shouldNotContain) expect(prompt).not.toContain(shouldNotContain);
  });

  test("truncates long output to 4000 chars per check", () => {
    const longOutput = "Q".repeat(10_000);
    const prompt = RectifierPromptBuilder.firstAttemptDelta([makeCheck("lint", longOutput)], 2);

    const qCount = (prompt.match(/Q/g) ?? []).length;
    expect(qCount).toBeLessThanOrEqual(4010); // +10 slack: CONTRADICTION_ESCAPE_HATCH contains "PRD_QUOTE" (one uppercase Q)
    expect(qCount).toBeLessThan(10_000);
    expect(prompt).toContain("truncated");
    expect(prompt).toContain("10000 chars total");
  });

  test("includes structured findings when present; omits section when absent", () => {
    const withFindings = RectifierPromptBuilder.firstAttemptDelta(
      [makeCheckWithFindings("semantic", "Semantic review failed")],
      2,
    );
    expect(withFindings).toContain("Structured findings:");
    expect(withFindings).toContain("[error] src/foo.ts:42 — Missing implementation for AC-1");

    const withoutFindings = RectifierPromptBuilder.firstAttemptDelta([makeCheck("lint", "some lint error")], 2);
    expect(withoutFindings).not.toContain("Structured findings:");
  });
});

describe("RectifierPromptBuilder.continuation", () => {
  test("contains follow-up signal, error output from all checks, and check name header", () => {
    const checks = [
      makeCheck("lint", "error TS2345: Argument of type 'string' is not assignable", 2),
      makeCheck("typecheck", "src/index.ts(10,3): error TS2304: Cannot find name 'foo'"),
    ];
    const prompt = RectifierPromptBuilder.continuation(
      checks,
      ...(Object.values(DEFAULTS) as [number, number, number]),
    );
    expect(prompt).toContain("Your previous fix attempt did not resolve all issues");
    expect(prompt).toContain("error TS2345: Argument of type 'string' is not assignable");
    expect(prompt).toContain("src/index.ts(10,3): error TS2304: Cannot find name 'foo'");
    expect(prompt).toContain("### lint (exit 2)");
  });

  test.each([
    ["present", [makeCheckWithFindings("semantic", "Semantic review failed")], true],
    ["absent", [makeCheck("lint", "some lint error")], false],
  ] as const)("structured findings when %s", (_label, checks, shouldInclude) => {
    const prompt = RectifierPromptBuilder.continuation(
      checks as any,
      ...(Object.values(DEFAULTS) as [number, number, number]),
    );
    if (shouldInclude) {
      expect(prompt).toContain("Structured findings:");
      expect(prompt).toContain("[error] src/foo.ts:42 — Missing implementation for AC-1");
    } else {
      expect(prompt).not.toContain("Structured findings:");
    }
  });

  test.each<[number, boolean]>([
    [1, false],
    [2, true],
    [3, true],
  ])("rethink preamble at attempt %i includes=%s", (attempt, shouldInclude) => {
    const prompt = RectifierPromptBuilder.continuation([makeCheck("lint", "error")], attempt, 2, 3);
    if (shouldInclude) expect(prompt).toContain("Rethink your approach");
    else expect(prompt).not.toContain("Rethink your approach");
  });

  test.each<[number, boolean]>([
    [1, false],
    [3, true],
  ])("urgency preamble at attempt %i includes=%s", (attempt, shouldInclude) => {
    const prompt = RectifierPromptBuilder.continuation([makeCheck("lint", "error")], attempt, 2, 3);
    if (shouldInclude) expect(prompt).toContain("URGENT");
    else expect(prompt).not.toContain("URGENT");
  });

  test("UNRESOLVED present in every continuation, 'final attempt' at urgencyAtAttempt; handles multiple failed checks", () => {
    for (const attempt of [1, 2, 3]) {
      const prompt = RectifierPromptBuilder.continuation([makeCheck("lint", "error")], attempt, 2, 3);
      expect(prompt).toContain("UNRESOLVED:");
    }
    expect(RectifierPromptBuilder.continuation([makeCheck("lint", "error")], 3, 2, 3)).toContain("final attempt");

    const multiPrompt = RectifierPromptBuilder.continuation(
      [
        makeCheck("lint", "lint error output"),
        makeCheck("typecheck", "typecheck error output"),
        makeCheck("semantic", "semantic error output"),
      ],
      ...(Object.values(DEFAULTS) as [number, number, number]),
    );
    expect(multiPrompt).toContain("### lint");
    expect(multiPrompt).toContain("### typecheck");
    expect(multiPrompt).toContain("### semantic");
  });

  test.each([
    ["constitution", /constitution/i],
    ["acceptance criteria header", /### acceptance criteria/i],
    ["story title block", /^Story:/m],
  ])("continuation prompt does NOT contain %s", (_label, pattern) => {
    const prompt = RectifierPromptBuilder.continuation(
      [makeCheck("lint", "error")],
      ...(Object.values(DEFAULTS) as [number, number, number]),
    );
    expect(prompt).not.toMatch(pattern);
  });

  test("truncates long output to 4000 chars per check", () => {
    const longOutput = "z".repeat(10_000);
    const prompt = RectifierPromptBuilder.continuation(
      [makeCheck("lint", longOutput)],
      ...(Object.values(DEFAULTS) as [number, number, number]),
    );

    // The truncated output slice should not contain the full 10000 chars
    const zCount = (prompt.match(/z/g) ?? []).length;
    expect(zCount).toBeLessThanOrEqual(4000);
    // And the original 10000 chars were cut down
    expect(zCount).toBeLessThan(10_000);
  });
});

// ---------------------------------------------------------------------------
// RectifierPromptBuilder.testWriterRectification (#409)
// ---------------------------------------------------------------------------

describe("RectifierPromptBuilder.testWriterRectification", () => {
  function makeTestFileCheck(file: string, message: string): import("@/review/types").ReviewCheckResult {
    return {
      check: "adversarial",
      success: false,
      command: "adversarial-review",
      exitCode: 1,
      output: "adversarial output",
      durationMs: 100,
      findings: [
        {
          ruleId: "adversarial",
          severity: "error",
          file,
          line: 10,
          message,
          source: "adversarial-review",
        },
      ],
    };
  }

  function makeStory(
    overrides: Partial<{ id: string; title: string; workdir: string; acceptanceCriteria: string[] }> = {},
  ) {
    return {
      id: overrides.id ?? "US-409",
      title: overrides.title ?? "Fix deadlock",
      workdir: overrides.workdir,
      acceptanceCriteria: overrides.acceptanceCriteria ?? ["AC-1: Does the thing", "AC-2: Handles edge case"],
    } as any;
  }

  test("adversarial check: finding message/file/severity, multiple findings, adversarial opener, section label, and spec instruction", () => {
    const checks = [
      makeTestFileCheck("test/unit/bar.test.ts", "Incomplete test coverage"),
      makeTestFileCheck("test/unit/baz.test.ts", "Second finding"),
    ];
    const prompt = RectifierPromptBuilder.testWriterRectification(checks, makeStory());
    // Finding content
    expect(prompt).toContain("Incomplete test coverage");
    expect(prompt).toContain("[error] test/unit/bar.test.ts:10 — Incomplete test coverage");
    // Multiple findings
    expect(prompt).toContain("Second finding");
    expect(prompt).toContain("test/unit/baz.test.ts");
    // Adversarial-specific
    expect(prompt).toContain("You are fixing test file issues flagged by an adversarial code reviewer.");
    expect(prompt).toContain("### Test File Findings (adversarial review)");
    expect(prompt).toContain("Do NOT delete a failing test");
    expect(prompt).toContain("SPECIFICATION");
    expect(prompt).toContain("not the current behavior");
  });

  test.each([
    ["without workdir", undefined, "Only modify test files", "Do NOT touch source implementation files"],
    [
      "with workdir packages/api",
      "packages/api",
      "Only modify test files within `packages/api/`",
      "Do NOT touch source files",
    ],
  ] as const)("constraint %s", (_label, workdir, expectedConstraint, expectedNoTouch) => {
    const checks = [makeTestFileCheck("test/unit/foo.test.ts", "finding")];
    const prompt = RectifierPromptBuilder.testWriterRectification(checks, makeStory({ workdir }));
    expect(prompt).toContain(expectedConstraint);
    expect(prompt).toContain(expectedNoTouch);
  });

  test("contains AC list, story id/title, no-delete constraint, and commit instruction", () => {
    const checks = [makeTestFileCheck("test/unit/foo.test.ts", "finding")];
    const story = makeStory({
      id: "US-409",
      title: "Resolve deadlock",
      acceptanceCriteria: ["AC-1: First criterion", "AC-2: Second criterion"],
    });
    const prompt = RectifierPromptBuilder.testWriterRectification(checks, story);
    expect(prompt).toContain("1. AC-1: First criterion");
    expect(prompt).toContain("2. AC-2: Second criterion");
    expect(prompt).toContain("US-409");
    expect(prompt).toContain("Resolve deadlock");
    expect(prompt).toContain("Do NOT delete a failing test");
    expect(prompt).toContain("Do NOT modify source implementation files");
    expect(prompt).toContain("Commit your fixes when done");
  });

  test("lint-only check: uses lint opener, includes raw output, and simplified note", () => {
    const lintCheck: import("@/review/types").ReviewCheckResult = {
      check: "lint",
      success: false,
      command: "bun run lint",
      exitCode: 1,
      output: "foo.test.ts:5 error — some lint error",
      durationMs: 100,
    };
    const prompt = RectifierPromptBuilder.testWriterRectification([lintCheck], makeStory());

    expect(prompt).toContain("You are fixing test file lint errors.");
    expect(prompt).toContain("### Test File Findings (lint)");
    expect(prompt).not.toContain("adversarial");
    expect(prompt).toContain("foo.test.ts:5 error — some lint error");
    expect(prompt).toContain("Fix the lint errors");
    expect(prompt).not.toContain("verify each finding is a real issue");
  });

  // D1 — Anti-assertion-loosening constraints (#897)
  test.each([
    ["forbids loosening assertions", "Do NOT loosen assertions to match current implementation behavior"],
    ["forbids deleting failing tests", "Do NOT delete a failing test"],
  ])("adversarial check: %s", (_label, expected) => {
    const checks = [makeTestFileCheck("test/unit/foo.test.ts", "finding")];
    const prompt = RectifierPromptBuilder.testWriterRectification(checks, makeStory());
    expect(prompt).toContain(expected);
  });
});

// D2 — write-failing-test mode (#897)
describe("RectifierPromptBuilder.testWriterRectification — write-failing-test mode", () => {
  function makeSourceBugCheck(file: string, message: string): import("@/review/types").ReviewCheckResult {
    return {
      check: "adversarial",
      success: false,
      command: "adversarial-review",
      exitCode: 1,
      output: "adversarial output",
      durationMs: 100,
      findings: [
        {
          severity: "error",
          file,
          line: 203,
          message,
          source: "adversarial-review",
          fixTarget: "source" as const,
          category: "error-path",
        },
      ],
    };
  }

  function makeStory() {
    return {
      id: "US-897",
      title: "Incremental Graph Diff",
      workdir: undefined,
      acceptanceCriteria: ["AC-1: Graph diffs are computed correctly"],
    } as any;
  }

  test("write-failing-test mode: instructs to write failing test, excludes source-fix language, includes bug details", () => {
    const checks = [makeSourceBugCheck("src/service.ts", "deleteMany uses node.id instead of GraphNode.id")];
    const prompt = RectifierPromptBuilder.testWriterRectification(checks, makeStory(), { mode: "write-failing-test" });
    expect(prompt).toContain("failing test");
    expect(prompt).toContain("spec-correct");
    expect(prompt).toContain("FAIL with the current");
    expect(prompt).not.toContain("Fix the lint errors");
    expect(prompt).not.toContain("You are fixing test file");
    expect(prompt).toContain("deleteMany uses node.id instead of GraphNode.id");
    expect(prompt).toContain("src/service.ts");
  });

  test("blockingThreshold='error' drops advisory findings from write-failing-test mode", () => {
    const checks: import("@/review/types").ReviewCheckResult[] = [
      {
        check: "adversarial",
        success: false,
        command: "adversarial-cmd",
        exitCode: 1,
        output: "Adversarial review failed",
        durationMs: 100,
        findings: [
          {
            severity: "error",
            file: "src/svc.ts",
            line: 1,
            message: "real bug",
            category: "",
            source: "adversarial-review",
          },
          {
            severity: "warning",
            file: "src/svc.ts",
            line: 2,
            message: "advisory warning",
            category: "",
            source: "adversarial-review",
          },
          {
            severity: "info",
            file: "src/svc.ts",
            line: 3,
            message: "fyi note",
            category: "",
            source: "adversarial-review",
          },
        ],
      },
    ];
    const prompt = RectifierPromptBuilder.testWriterRectification(checks, makeStory(), {
      mode: "write-failing-test",
      blockingThreshold: "error",
    });
    expect(prompt).toContain("real bug");
    expect(prompt).not.toContain("advisory warning");
    expect(prompt).not.toContain("fyi note");
  });
});

// ---------------------------------------------------------------------------
// buildEscapeHatch({ includeMockHandoff: true }) — Exception 4 (mock-structure handoff)
// ---------------------------------------------------------------------------

import { buildEscapeHatch } from "@/prompts/builders/rectifier-builder-helpers";

describe("buildEscapeHatch({ includeMockHandoff: true }) — Exception 4", () => {
  const tddHatch = buildEscapeHatch({ includeMockHandoff: true });

  test("includes Exception 4 title, required fields, and UNRESOLVED handoff rule", () => {
    expect(tddHatch).toContain("Exception 4 — Mock-structure handoff");
    expect(tddHatch).toContain("TEST_EDIT_REASON: mock_structure");
    expect(tddHatch).toContain("Do NOT also emit `UNRESOLVED:` in the same turn — this declaration IS the handoff.");
  });

  test.each(["FILES:", "REASON:"])("lists %s as a required field", (field) => {
    const afterException4 = tddHatch.slice(tddHatch.indexOf("Exception 4"));
    expect(afterException4).toContain(field);
  });
});

// ---------------------------------------------------------------------------
// RectifierPromptBuilder.testWriterRectification — mock-restructure mode
// ---------------------------------------------------------------------------

describe("RectifierPromptBuilder.testWriterRectification — mock-restructure mode", () => {
  function makeStory() {
    return {
      id: "US-003",
      title: "Restructure mocks",
      workdir: undefined,
      acceptanceCriteria: ["AC-1: Mocks align with dispatch shape", "AC-2: No source changes"],
    } as any;
  }

  function makeCheck(check: string, output: string): ReviewCheckResult {
    return {
      check: check as ReviewCheckResult["check"],
      success: false,
      command: `${check}-cmd`,
      exitCode: 1,
      output,
      durationMs: 100,
    };
  }

  test.each([
    ["renderer opener", "You are restructuring test mocks"],
    ["source file constraint", "Do NOT modify any source file"],
    ["story id", "US-003"],
    ["story title", "Restructure mocks"],
    ["acceptance criteria heading", "Acceptance Criteria"],
    ["first AC", "AC-1: Mocks align with dispatch shape"],
  ])("mock-restructure: includes %s", (_label, expected) => {
    const prompt = RectifierPromptBuilder.testWriterRectification([makeCheck("adversarial", "output")], makeStory(), {
      mode: "mock-restructure",
      handoffReason: "reason",
      handoffFiles: ["test/unit/foo.test.ts"],
    });
    expect(prompt).toContain(expected);
  });

  test("returned prompt contains verbatim handoffReason and lists every handoffFile under heading", () => {
    const handoffReason = "Mocks reference primitives the new code bypasses via callOp dispatch";
    const handoffFiles = ["test/unit/agents/adapter.test.ts", "test/unit/pipeline/stages/autofix.test.ts"];
    const prompt = RectifierPromptBuilder.testWriterRectification([makeCheck("adversarial", "output")], makeStory(), {
      mode: "mock-restructure",
      handoffReason,
      handoffFiles,
    });
    expect(prompt).toContain(handoffReason);
    expect(prompt).toContain("Files to rewrite (only these)");
    for (const file of handoffFiles) {
      expect(prompt).toContain(file);
    }
  });

  test("returned prompt references assertion keywords to indicate assertion sites are forbidden", () => {
    const prompt = RectifierPromptBuilder.testWriterRectification([makeCheck("adversarial", "output")], makeStory(), {
      mode: "mock-restructure",
      handoffReason: "reason",
      handoffFiles: ["test/unit/foo.test.ts"],
    });

    const hasAssertionKeyword =
      prompt.includes("expect(") || prompt.includes("toBe") || prompt.includes("toEqual") || prompt.includes("toThrow");
    expect(hasAssertionKeyword).toBe(true);
  });

  test("without mode argument, returns the existing fix-test-files prompt", () => {
    const checks = [makeCheck("adversarial", "some adversarial output")];
    const story = makeStory();

    const withoutMode = RectifierPromptBuilder.testWriterRectification(checks, story);
    const withExplicitDefault = RectifierPromptBuilder.testWriterRectification(checks, story, {
      mode: "fix-test-files",
    });

    expect(withoutMode).toBe(withExplicitDefault);
  });
});

describe("RectifierPromptBuilder.reviewRectification — blocking-only defensive filter", () => {
  function makeStory() {
    return {
      id: "US-test",
      title: "Test story",
      workdir: undefined,
      acceptanceCriteria: ["AC-1: Does the thing"],
    } as any;
  }

  function makeMixedSeverityCheck(): import("@/review/types").ReviewCheckResult {
    return {
      check: "semantic",
      success: false,
      command: "semantic-cmd",
      exitCode: 1,
      output: "Semantic review failed",
      durationMs: 100,
      findings: [
        { severity: "error", file: "a.ts", line: 1, message: "real issue", category: "", source: "semantic-review" },
        { severity: "warning", file: "b.ts", line: 2, message: "advisory", category: "", source: "semantic-review" },
        { severity: "info", file: "c.ts", line: 3, message: "fyi", category: "", source: "semantic-review" },
      ],
    };
  }

  test("blockingThreshold='error' drops advisory/info findings; absent threshold defaults to error (advisory excluded)", () => {
    const checks = [makeMixedSeverityCheck()];

    const deltaPrompt = RectifierPromptBuilder.firstAttemptDelta(checks, 3);
    expect(deltaPrompt).toContain("a.ts:1");
    expect(deltaPrompt).not.toContain("b.ts:2");
    expect(deltaPrompt).not.toContain("c.ts:3");

    const reviewPrompt = RectifierPromptBuilder.reviewRectification(checks, makeStory());
    // The semantic path uses formatCheckErrors (raw output), not structured findings
    expect(reviewPrompt).toContain("Semantic review failed");
  });
});

describe("RectifierPromptBuilder.reviewRectification — scope guidance (package-local prerequisite)", () => {
  test("allows package-local prerequisite fixes before classifying a failure as sibling spillover", () => {
    const story = makeStory({
      id: "US-001",
      title: "Prefer const over let in greet()",
      acceptanceCriteria: ["bun run typecheck exits with code 0"],
      routing: { testStrategy: "no-test", complexity: "simple", reasoning: "no-op change" },
    });
    const failedChecks: ReviewCheckResult[] = [
      {
        check: "typecheck",
        success: false,
        command: "bun run typecheck",
        exitCode: 2,
        output: "error TS2688: Cannot find type definition file for 'bun-types'.",
        durationMs: 1,
      },
    ];
    const prompt = RectifierPromptBuilder.reviewRectification(failedChecks, story);
    expect(prompt).toContain("smallest package-local fix is required");
    expect(prompt).toContain("TEST_EDIT_REASON: sibling_scope");
    expect(prompt).not.toContain(
      "When a lint or typecheck error is in a file you did NOT create or modify in this turn",
    );
  });
});

describe("RectifierPromptBuilder.failingTestContext", () => {
  test("returns string with failure details; handles empty array gracefully", () => {
    const findings: Finding[] = [
      {
        source: "test-runner",
        severity: "error",
        category: "failed-test",
        rule: "should handle edge case",
        file: "test/unit/foo.test.ts",
        message: "Expected 1 but got 0",
      },
    ];
    const result = RectifierPromptBuilder.failingTestContext(findings);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain("should handle edge case");
    expect(result).toContain("Expected 1 but got 0");
    const emptyResult = RectifierPromptBuilder.failingTestContext([]);
    expect(typeof emptyResult).toBe("string");
  });

  // AC-1
  test("contains rule, message, and implementation-fix directive for test-runner finding", () => {
    const finding: Finding = {
      source: "test-runner",
      severity: "error",
      category: "failed-test",
      rule: "should reject expired token",
      file: "test/unit/auth.test.ts",
      message: "Expected 1 received 0",
    };
    const result = RectifierPromptBuilder.failingTestContext([finding]);
    expect(result).toContain("should reject expired token");
    expect(result).toContain("Expected 1 received 0");
    expect(result).toContain("Fix the implementation (not the tests)");
  });
});

describe("RectifierPromptBuilder.failingTestRectification", () => {
  const finding: Finding = {
    source: "test-runner",
    severity: "error",
    category: "failed-test",
    rule: "should reject expired token",
    file: "test/unit/auth.test.ts",
    message: "Expected 1 received 0",
  };

  // AC-2
  test("three-session TDD story: contains finding message, TEST_EDIT_REASON, and mock_structure", () => {
    const story = makeStory({
      routing: { testStrategy: "three-session-tdd", complexity: "medium", reasoning: "tdd" },
    });
    const result = RectifierPromptBuilder.failingTestRectification([finding], story);
    expect(result).toContain("Expected 1 received 0");
    expect(result).toContain("TEST_EDIT_REASON");
    expect(result).toContain("mock_structure");
  });

  // AC-3
  test("three-session story: contains loosen assertion guard", () => {
    const story = makeStory({
      routing: { testStrategy: "three-session-tdd", complexity: "medium", reasoning: "tdd" },
    });
    const result = RectifierPromptBuilder.failingTestRectification([finding], story);
    expect(result).toContain("loosen assertion");
  });

  // AC-4
  test("single-session test-after story: contains permit and does not contain mock_structure", () => {
    const story = makeStory({
      routing: { testStrategy: "test-after", complexity: "simple", reasoning: "test-after" },
    });
    const result = RectifierPromptBuilder.failingTestRectification([finding], story);
    expect(result).toContain("you MAY edit test files");
    expect(result).not.toContain("mock_structure");
  });
});
