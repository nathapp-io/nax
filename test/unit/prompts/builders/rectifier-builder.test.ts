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
import { RectifierPromptBuilder } from "../../../../src/prompts/builders/rectifier-builder";
import type { ReviewCheckResult } from "../../../../src/review/types";

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
  test("contains the failed check output", () => {
    const prompt = RectifierPromptBuilder.firstAttemptDelta(
      [makeCheck("lint", "Unexpected token at line 10")],
      2,
    );

    expect(prompt).toContain("Unexpected token at line 10");
  });

  test("contains check name and exit code in section header", () => {
    const prompt = RectifierPromptBuilder.firstAttemptDelta(
      [makeCheck("typecheck", "TS2345 error", 2)],
      2,
    );

    expect(prompt).toContain("### typecheck (exit 2)");
  });

  test("contains maxAttempts count in singular form when maxAttempts === 1", () => {
    const prompt = RectifierPromptBuilder.firstAttemptDelta(
      [makeCheck("lint", "error")],
      1,
    );

    expect(prompt).toContain("1 attempt");
    expect(prompt).not.toContain("1 attempts");
  });

  test("contains maxAttempts count in plural form when maxAttempts > 1", () => {
    const prompt = RectifierPromptBuilder.firstAttemptDelta(
      [makeCheck("lint", "error")],
      3,
    );

    expect(prompt).toContain("3 attempts");
  });

  test("truncates long output to 4000 chars per check", () => {
    const longOutput = "Q".repeat(10_000);
    const prompt = RectifierPromptBuilder.firstAttemptDelta(
      [makeCheck("lint", longOutput)],
      2,
    );

    const qCount = (prompt.match(/Q/g) ?? []).length;
    expect(qCount).toBeLessThanOrEqual(4000);
    expect(qCount).toBeLessThan(10_000);
    expect(prompt).toContain("truncated");
    expect(prompt).toContain("10000 chars total");
  });

  test("includes structured findings when present", () => {
    const prompt = RectifierPromptBuilder.firstAttemptDelta(
      [makeCheckWithFindings("semantic", "Semantic review failed")],
      2,
    );

    expect(prompt).toContain("Structured findings:");
    expect(prompt).toContain("[error] src/foo.ts:42 — Missing implementation for AC-1");
  });

  test("does NOT include findings section when findings are absent", () => {
    const prompt = RectifierPromptBuilder.firstAttemptDelta(
      [makeCheck("lint", "some lint error")],
      2,
    );

    expect(prompt).not.toContain("Structured findings:");
  });

  test("CONTRADICTION_ESCAPE_HATCH is present", () => {
    const prompt = RectifierPromptBuilder.firstAttemptDelta(
      [makeCheck("lint", "error")],
      2,
    );

    expect(prompt).toContain("UNRESOLVED:");
  });

  test("instructs agent to fix in priority order, verify, and commit", () => {
    const prompt = RectifierPromptBuilder.firstAttemptDelta(
      [makeCheck("lint", "error")],
      2,
    );

    expect(prompt).toContain("Fix in priority order");
    expect(prompt).toContain("re-run the failing check(s) at that level to verify they pass before moving on");
    expect(prompt).toContain("Commit your changes when all checks pass");
  });

  test("does NOT include story title or acceptance criteria sections", () => {
    const prompt = RectifierPromptBuilder.firstAttemptDelta(
      [makeCheck("lint", "error")],
      2,
    );

    expect(prompt.toLowerCase()).not.toContain("acceptance criteria");
    expect(prompt).not.toMatch(/^Story:/m);
    expect(prompt.toLowerCase()).not.toContain("constitution");
  });

  test("handles multiple failed checks", () => {
    const checks = [
      makeCheck("lint", "lint error output"),
      makeCheck("typecheck", "typecheck error output"),
    ];

    const prompt = RectifierPromptBuilder.firstAttemptDelta(checks, 2);

    expect(prompt).toContain("### lint");
    expect(prompt).toContain("### typecheck");
    expect(prompt).toContain("lint error output");
    expect(prompt).toContain("typecheck error output");
  });
});

describe("RectifierPromptBuilder.continuation", () => {
  test("contains opening signal that this is a follow-up attempt", () => {
    const prompt = RectifierPromptBuilder.continuation(
      [makeCheck("lint", "Unexpected token at line 10")],
      ...Object.values(DEFAULTS) as [number, number, number],
    );

    expect(prompt).toContain("Your previous fix attempt did not resolve all issues");
  });

  test("contains error output from failedChecks", () => {
    const checks = [
      makeCheck("lint", "error TS2345: Argument of type 'string' is not assignable"),
      makeCheck("typecheck", "src/index.ts(10,3): error TS2304: Cannot find name 'foo'"),
    ];

    const prompt = RectifierPromptBuilder.continuation(
      checks,
      ...Object.values(DEFAULTS) as [number, number, number],
    );

    expect(prompt).toContain("error TS2345: Argument of type 'string' is not assignable");
    expect(prompt).toContain("src/index.ts(10,3): error TS2304: Cannot find name 'foo'");
  });

  test("contains check name and exit code in section header", () => {
    const prompt = RectifierPromptBuilder.continuation(
      [makeCheck("lint", "some lint error", 2)],
      ...Object.values(DEFAULTS) as [number, number, number],
    );

    expect(prompt).toContain("### lint (exit 2)");
  });

  test("contains structured findings when present", () => {
    const prompt = RectifierPromptBuilder.continuation(
      [makeCheckWithFindings("semantic", "Semantic review failed")],
      ...Object.values(DEFAULTS) as [number, number, number],
    );

    expect(prompt).toContain("Structured findings:");
    expect(prompt).toContain("[error] src/foo.ts:42 — Missing implementation for AC-1");
  });

  test("does NOT include findings section when findings are absent", () => {
    const prompt = RectifierPromptBuilder.continuation(
      [makeCheck("lint", "some lint error")],
      ...Object.values(DEFAULTS) as [number, number, number],
    );

    expect(prompt).not.toContain("Structured findings:");
  });

  test("does NOT include rethink preamble before rethinkAtAttempt", () => {
    const prompt = RectifierPromptBuilder.continuation(
      [makeCheck("lint", "error")],
      1, // attempt 1 — below rethinkAtAttempt (2)
      2,
      3,
    );

    expect(prompt).not.toContain("Rethink your approach");
  });

  test("includes rethink preamble at rethinkAtAttempt", () => {
    const prompt = RectifierPromptBuilder.continuation(
      [makeCheck("lint", "error")],
      2, // attempt == rethinkAtAttempt
      2,
      3,
    );

    expect(prompt).toContain("Rethink your approach");
  });

  test("includes rethink preamble after rethinkAtAttempt", () => {
    const prompt = RectifierPromptBuilder.continuation(
      [makeCheck("lint", "error")],
      3, // attempt > rethinkAtAttempt
      2,
      3,
    );

    expect(prompt).toContain("Rethink your approach");
  });

  test("does NOT include urgency preamble before urgencyAtAttempt", () => {
    const prompt = RectifierPromptBuilder.continuation(
      [makeCheck("lint", "error")],
      1, // attempt 1 — below urgencyAtAttempt (3)
      2,
      3,
    );

    expect(prompt).not.toContain("URGENT");
  });

  test("includes urgency preamble at urgencyAtAttempt", () => {
    const prompt = RectifierPromptBuilder.continuation(
      [makeCheck("lint", "error")],
      3, // attempt == urgencyAtAttempt
      2,
      3,
    );

    expect(prompt).toContain("URGENT");
    expect(prompt).toContain("final attempt");
  });

  test("CONTRADICTION_ESCAPE_HATCH is present in every continuation prompt", () => {
    const attempts = [1, 2, 3];
    for (const attempt of attempts) {
      const prompt = RectifierPromptBuilder.continuation(
        [makeCheck("lint", "error")],
        attempt,
        2,
        3,
      );
      // The escape hatch instructs the agent to emit UNRESOLVED: when findings conflict
      expect(prompt).toContain("UNRESOLVED:");
    }
  });

  test("continuation prompt does NOT contain constitution", () => {
    const prompt = RectifierPromptBuilder.continuation(
      [makeCheck("lint", "error")],
      ...Object.values(DEFAULTS) as [number, number, number],
    );

    expect(prompt.toLowerCase()).not.toContain("constitution");
  });

  test("continuation prompt does NOT contain 'acceptance criteria' section header", () => {
    const prompt = RectifierPromptBuilder.continuation(
      [makeCheck("semantic", "AC-1 missing")],
      ...Object.values(DEFAULTS) as [number, number, number],
    );

    // Should not have the full AC list or the "Acceptance Criteria" section found in full prompts
    expect(prompt.toLowerCase()).not.toContain("acceptance criteria");
  });

  test("continuation prompt does NOT contain story title section", () => {
    const prompt = RectifierPromptBuilder.continuation(
      [makeCheck("lint", "error")],
      ...Object.values(DEFAULTS) as [number, number, number],
    );

    // Should not open with the full story context block
    expect(prompt).not.toMatch(/^Story:/m);
  });

  test("truncates long output to 4000 chars per check", () => {
    const longOutput = "z".repeat(10_000);
    const prompt = RectifierPromptBuilder.continuation(
      [makeCheck("lint", longOutput)],
      ...Object.values(DEFAULTS) as [number, number, number],
    );

    // The truncated output slice should not contain the full 10000 chars
    const zCount = (prompt.match(/z/g) ?? []).length;
    expect(zCount).toBeLessThanOrEqual(4000);
    // And the original 10000 chars were cut down
    expect(zCount).toBeLessThan(10_000);
  });

  test("handles multiple failed checks", () => {
    const checks = [
      makeCheck("lint", "lint error output"),
      makeCheck("typecheck", "typecheck error output"),
      makeCheck("semantic", "semantic error output"),
    ];

    const prompt = RectifierPromptBuilder.continuation(
      checks,
      ...Object.values(DEFAULTS) as [number, number, number],
    );

    expect(prompt).toContain("### lint");
    expect(prompt).toContain("### typecheck");
    expect(prompt).toContain("### semantic");
  });
});

// ---------------------------------------------------------------------------
// RectifierPromptBuilder.testWriterRectification (#409)
// ---------------------------------------------------------------------------

describe("RectifierPromptBuilder.testWriterRectification", () => {
  function makeTestFileCheck(file: string, message: string): import("../../../../src/review/types").ReviewCheckResult {
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

  test("contains the finding message", () => {
    const checks = [makeTestFileCheck("test/unit/foo.test.ts", "Missing assertion for edge case")];
    const prompt = RectifierPromptBuilder.testWriterRectification(checks, makeStory());

    expect(prompt).toContain("Missing assertion for edge case");
  });

  test("contains the file path and severity in finding line", () => {
    const checks = [makeTestFileCheck("test/unit/bar.test.ts", "Incomplete test coverage")];
    const prompt = RectifierPromptBuilder.testWriterRectification(checks, makeStory());

    expect(prompt).toContain("[error] test/unit/bar.test.ts:10 — Incomplete test coverage");
  });

  test("contains 'Only modify test files' constraint without workdir", () => {
    const checks = [makeTestFileCheck("test/unit/foo.test.ts", "finding")];
    const prompt = RectifierPromptBuilder.testWriterRectification(checks, makeStory({ workdir: undefined }));

    expect(prompt).toContain("Only modify test files");
    expect(prompt).toContain("Do NOT touch source implementation files");
  });

  test("contains workdir-scoped constraint when story.workdir is set", () => {
    const checks = [makeTestFileCheck("test/unit/foo.test.ts", "finding")];
    const prompt = RectifierPromptBuilder.testWriterRectification(checks, makeStory({ workdir: "packages/api" }));

    expect(prompt).toContain("Only modify test files within `packages/api/`");
    expect(prompt).toContain("Do NOT touch source files");
  });

  test("contains the acceptance criteria list", () => {
    const checks = [makeTestFileCheck("test/unit/foo.test.ts", "finding")];
    const story = makeStory({ acceptanceCriteria: ["AC-1: First criterion", "AC-2: Second criterion"] });
    const prompt = RectifierPromptBuilder.testWriterRectification(checks, story);

    expect(prompt).toContain("1. AC-1: First criterion");
    expect(prompt).toContain("2. AC-2: Second criterion");
  });

  test("contains the story id and title", () => {
    const checks = [makeTestFileCheck("test/unit/foo.test.ts", "finding")];
    const story = makeStory({ id: "US-409", title: "Resolve deadlock" });
    const prompt = RectifierPromptBuilder.testWriterRectification(checks, story);

    expect(prompt).toContain("US-409");
    expect(prompt).toContain("Resolve deadlock");
  });

  test("instructs not to delete failing tests or modify source files", () => {
    const checks = [makeTestFileCheck("test/unit/foo.test.ts", "finding")];
    const prompt = RectifierPromptBuilder.testWriterRectification(checks, makeStory());

    expect(prompt).toContain("Do NOT delete a failing test");
    expect(prompt).toContain("Do NOT modify source implementation files");
  });

  test("instructs to commit fixes when done", () => {
    const checks = [makeTestFileCheck("test/unit/foo.test.ts", "finding")];
    const prompt = RectifierPromptBuilder.testWriterRectification(checks, makeStory());

    expect(prompt).toContain("Commit your fixes when done");
  });

  test("handles multiple findings across multiple checks", () => {
    const checks = [
      makeTestFileCheck("test/unit/foo.test.ts", "First finding"),
      makeTestFileCheck("test/unit/bar.test.ts", "Second finding"),
    ];
    const prompt = RectifierPromptBuilder.testWriterRectification(checks, makeStory());

    expect(prompt).toContain("First finding");
    expect(prompt).toContain("Second finding");
    expect(prompt).toContain("test/unit/foo.test.ts");
    expect(prompt).toContain("test/unit/bar.test.ts");
  });

  test("adversarial check: uses adversarial opener and section label", () => {
    const checks = [makeTestFileCheck("test/unit/foo.test.ts", "finding")];
    const prompt = RectifierPromptBuilder.testWriterRectification(checks, makeStory());

    expect(prompt).toContain("You are fixing test file issues flagged by an adversarial code reviewer.");
    expect(prompt).toContain("### Test File Findings (adversarial review)");
    expect(prompt).toContain("Do NOT delete a failing test");
  });

  test("lint-only check: uses lint opener and section label", () => {
    const lintCheck: import("../../../../src/review/types").ReviewCheckResult = {
      check: "lint",
      success: false,
      command: "bun run lint",
      exitCode: 1,
      output: "apps/api/test/unit/foo.test.ts:10:5 error — Unexpected console statement",
      durationMs: 100,
    };
    const prompt = RectifierPromptBuilder.testWriterRectification([lintCheck], makeStory());

    expect(prompt).toContain("You are fixing test file lint errors.");
    expect(prompt).toContain("### Test File Findings (lint)");
    expect(prompt).not.toContain("adversarial");
  });

  test("lint-only check: includes raw output in findings section", () => {
    const lintCheck: import("../../../../src/review/types").ReviewCheckResult = {
      check: "lint",
      success: false,
      command: "bun run lint",
      exitCode: 1,
      output: "foo.test.ts:5 error — some lint error",
      durationMs: 100,
    };
    const prompt = RectifierPromptBuilder.testWriterRectification([lintCheck], makeStory());

    expect(prompt).toContain("foo.test.ts:5 error — some lint error");
  });

  test("lint-only check: uses simplified important note without verify-findings step", () => {
    const lintCheck: import("../../../../src/review/types").ReviewCheckResult = {
      check: "lint",
      success: false,
      command: "bun run lint",
      exitCode: 1,
      output: "some lint output",
      durationMs: 100,
    };
    const prompt = RectifierPromptBuilder.testWriterRectification([lintCheck], makeStory());

    expect(prompt).toContain("Fix the lint errors");
    expect(prompt).not.toContain("verify each finding is a real issue");
  });

  // D1 — Anti-assertion-loosening constraints (#897)
  test("adversarial check: forbids loosening assertions to match current implementation behavior", () => {
    const checks = [makeTestFileCheck("test/unit/foo.test.ts", "finding")];
    const prompt = RectifierPromptBuilder.testWriterRectification(checks, makeStory());

    expect(prompt).toContain("Do NOT loosen assertions to match current implementation behavior");
  });

  test("adversarial check: instructs to encode spec not current behavior", () => {
    const checks = [makeTestFileCheck("test/unit/foo.test.ts", "finding")];
    const prompt = RectifierPromptBuilder.testWriterRectification(checks, makeStory());

    expect(prompt).toContain("SPECIFICATION");
    expect(prompt).toContain("not the current behavior");
  });

  test("adversarial check: forbids deleting failing tests", () => {
    const checks = [makeTestFileCheck("test/unit/foo.test.ts", "finding")];
    const prompt = RectifierPromptBuilder.testWriterRectification(checks, makeStory());

    expect(prompt).toContain("Do NOT delete a failing test");
  });
});

// D2 — write-failing-test mode (#897)
describe("RectifierPromptBuilder.testWriterRectification — write-failing-test mode", () => {
  function makeSourceBugCheck(file: string, message: string): import("../../../../src/review/types").ReviewCheckResult {
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

  test("write-failing-test mode: instructs to write a failing test, not fix source", () => {
    const checks = [makeSourceBugCheck("src/service.ts", "upsertNode uses wrong identifier space")];
    const prompt = RectifierPromptBuilder.testWriterRectification(checks, makeStory(), { mode: "write-failing-test" });

    expect(prompt).toContain("failing test");
    expect(prompt).toContain("spec-correct");
    expect(prompt).toContain("FAIL with the current");
  });

  test("write-failing-test mode: does not instruct to fix source files", () => {
    const checks = [makeSourceBugCheck("src/service.ts", "wrong id")];
    const prompt = RectifierPromptBuilder.testWriterRectification(checks, makeStory(), { mode: "write-failing-test" });

    expect(prompt).not.toContain("Fix the lint errors");
    expect(prompt).not.toContain("You are fixing test file");
  });

  test("write-failing-test mode: includes the source bug finding details", () => {
    const checks = [makeSourceBugCheck("src/service.ts", "deleteMany uses node.id instead of GraphNode.id")];
    const prompt = RectifierPromptBuilder.testWriterRectification(checks, makeStory(), { mode: "write-failing-test" });

    expect(prompt).toContain("deleteMany uses node.id instead of GraphNode.id");
    expect(prompt).toContain("src/service.ts");
  });
});
