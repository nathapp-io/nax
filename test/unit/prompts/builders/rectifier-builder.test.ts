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

  test("instructs agent to fix ALL issues and commit", () => {
    const prompt = RectifierPromptBuilder.firstAttemptDelta(
      [makeCheck("lint", "error")],
      2,
    );

    expect(prompt).toContain("Fix ALL issues listed");
    expect(prompt).toContain("Commit your fixes when done");
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
