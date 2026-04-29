/**
 * Tests for RectifierPromptBuilder
 *
 * Covers the regressionFailure() static method which generates prompts for
 * implementers to fix test failures across the full test suite.
 *
 * Migration Note: Removed tests for the old fluent API (.for(), .story(), etc.)
 * which were replaced by direct static method calls in Phase 2.
 */

import { describe, expect, test } from "bun:test";
import { makeStory } from "../../helpers";
import { RectifierPromptBuilder } from "../../../src/prompts";
import type { FailureRecord } from "../../../src/prompts";
import type { ReviewCheckResult } from "../../../src/review/types";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const STORY = makeStory({
  id: "US-042",
  title: "Add rate limiter",
  description: "Implement rate limiting.",
  acceptanceCriteria: ["Rate limit returns 429"],
  attempts: 1,
});

const FAILURES: FailureRecord[] = [
  {
    test: "returns 429 when limit exceeded",
    file: "test/unit/rate-limiter.test.ts",
    message: "Expected 429, received 200",
    output: "at test/unit/rate-limiter.test.ts:34",
  },
];

const TEST_CMD = "bun test test/unit/";
const CONTEXT = "# Project Context\n\nThis project uses Bun 1.3+.";

// ─── RectifierPromptBuilder.regressionFailure() ────────────────────────────────

describe("RectifierPromptBuilder.regressionFailure()", () => {
  test("includes story title", () => {
    const result = RectifierPromptBuilder.regressionFailure({
      story: STORY,
      failures: FAILURES,
      testCommand: TEST_CMD,
    });
    expect(result).toContain(STORY.title);
  });

  test("includes story description", () => {
    const result = RectifierPromptBuilder.regressionFailure({
      story: STORY,
      failures: FAILURES,
      testCommand: TEST_CMD,
    });
    expect(result).toContain(STORY.description);
  });

  test("includes acceptance criteria", () => {
    const result = RectifierPromptBuilder.regressionFailure({
      story: STORY,
      failures: FAILURES,
      testCommand: TEST_CMD,
    });
    for (const ac of STORY.acceptanceCriteria) {
      expect(result).toContain(ac);
    }
  });

  test("includes failure messages", () => {
    const result = RectifierPromptBuilder.regressionFailure({
      story: STORY,
      failures: FAILURES,
      testCommand: TEST_CMD,
    });
    for (const f of FAILURES) {
      expect(result).toContain(f.message);
    }
  });

  test("includes test command", () => {
    const result = RectifierPromptBuilder.regressionFailure({
      story: STORY,
      failures: FAILURES,
      testCommand: TEST_CMD,
    });
    expect(result).toContain(TEST_CMD);
  });

  test("demands FULL test suite explicitly", () => {
    const result = RectifierPromptBuilder.regressionFailure({
      story: STORY,
      failures: FAILURES,
      testCommand: TEST_CMD,
    });
    expect(result).toContain("FULL repo test suite");
    expect(result).toContain("EXACT command");
    expect(result).toContain("cross-story regressions");
  });

  test("includes conventions by default", () => {
    const result = RectifierPromptBuilder.regressionFailure({
      story: STORY,
      failures: FAILURES,
      testCommand: TEST_CMD,
    });
    expect(result).toContain("Conventions");
  });

  test("omits conventions when disabled", () => {
    const result = RectifierPromptBuilder.regressionFailure({
      story: STORY,
      failures: FAILURES,
      testCommand: TEST_CMD,
      conventions: false,
    });
    // Should not contain the conventions section heading
    const lines = result.split("\n");
    const hasConventionsSection = lines.some((line) => line.startsWith("# Conventions"));
    expect(hasConventionsSection).toBe(false);
  });

  test("includes isolation when provided", () => {
    const result = RectifierPromptBuilder.regressionFailure({
      story: STORY,
      failures: FAILURES,
      testCommand: TEST_CMD,
      isolation: "strict",
    });
    expect(result).toContain("Isolation");
  });

  test("includes context when provided", () => {
    const result = RectifierPromptBuilder.regressionFailure({
      story: STORY,
      failures: FAILURES,
      testCommand: TEST_CMD,
      context: CONTEXT,
    });
    expect(result).toContain("Project Context");
  });

  test("includes constitution when provided", () => {
    const constitution = "# Constitution\n\nFollow these rules.";
    const result = RectifierPromptBuilder.regressionFailure({
      story: STORY,
      failures: FAILURES,
      testCommand: TEST_CMD,
      constitution,
    });
    expect(result).toContain("Follow these rules");
  });

  test("includes promptPrefix when provided", () => {
    const prefix = "DIAGNOSTIC: Retrying after escalation.";
    const result = RectifierPromptBuilder.regressionFailure({
      story: STORY,
      failures: FAILURES,
      testCommand: TEST_CMD,
      promptPrefix: prefix,
    });
    expect(result).toContain(prefix);
  });

  test("snapshot: regressionFailure() with minimal options", () => {
    const result = RectifierPromptBuilder.regressionFailure({
      story: STORY,
      failures: FAILURES,
      testCommand: TEST_CMD,
    });
    expect(result).toMatchSnapshot();
  });

  test("snapshot: regressionFailure() with all options", () => {
    const result = RectifierPromptBuilder.regressionFailure({
      story: STORY,
      failures: FAILURES,
      testCommand: TEST_CMD,
      conventions: true,
      isolation: "strict",
      context: CONTEXT,
      constitution: "# Constitution\n\nRules apply.",
      promptPrefix: "DIAGNOSTIC: Attempt 2",
    });
    expect(result).toMatchSnapshot();
  });
});

// ─── noOpReprompt — language-agnostic guidance ────────────────────────────────

describe("RectifierPromptBuilder.noOpReprompt", () => {
  const FAILED_CHECK = {
    check: "typecheck" as const,
    success: false,
    command: "tsc --noEmit",
    exitCode: 2,
    output: "error TS2688: Cannot find type definition file for 'bun-types'.",
    durationMs: 1234,
  };

  test("contains the core no-op directive and UNRESOLVED escape hatch", () => {
    const result = RectifierPromptBuilder.noOpReprompt([FAILED_CHECK], 0, 1);
    expect(result).toContain("no committed file changes");
    expect(result).toContain("UNRESOLVED");
    expect(result).toContain("commit");
  });

  test("does not bake in TypeScript/Node-specific file or command names", () => {
    // nax orchestrates polyglot monorepos. The no-op reprompt must not name
    // language-specific manifests (package.json/tsconfig.json) or single
    // ecosystems' install commands as authoritative — that misleads agents
    // working in Go/Python/Rust packages. See monorepo-awareness.md §B and
    // the precedent in #543 (acceptance/escalated test command).
    const result = RectifierPromptBuilder.noOpReprompt([FAILED_CHECK], 0, 1);
    expect(result).not.toContain("`package.json`");
    expect(result).not.toContain("`tsconfig.json`");
    // The phrase "bun install / npm install" alone (no other examples) was the
    // shape of the bug — the fix lists install commands across ecosystems.
    expect(result).toMatch(/go mod tidy|pip install|cargo/);
  });

  test("emits a warning when the no-op limit is reached", () => {
    const beforeLimit = RectifierPromptBuilder.noOpReprompt([FAILED_CHECK], 0, 1);
    const atLimit = RectifierPromptBuilder.noOpReprompt([FAILED_CHECK], 1, 1);
    expect(beforeLimit).not.toContain("WARNING");
    expect(atLimit).toContain("WARNING");
  });
});

// ─── firstAttemptDelta / continuation priority-bucket rendering ───────────────

const makeReviewCheck = (
  check: ReviewCheckResult["check"],
  overrides: Partial<ReviewCheckResult> = {},
): ReviewCheckResult => {
  return {
    check,
    success: false,
    command: `${check} command`,
    exitCode: 1,
    output: `${check} output`,
    durationMs: 10,
    ...overrides,
  };
};

describe("RectifierPromptBuilder.firstAttemptDelta", () => {
  test("single-category: renders only the matching priority bucket", () => {
    const result = RectifierPromptBuilder.firstAttemptDelta([makeReviewCheck("lint")], 3);

    expect(result).toContain("Order matters: fix Priority 1 first");
    expect(result).toContain("## Priority 2 — Lint/style");
    expect(result).not.toContain("## Priority 1 — Compile/build");
    expect(result).not.toContain("## Priority 3 — Behavior");
    expect(result).not.toContain("## Priority 4 — Semantic");
    expect(result).not.toContain("## Priority 5 — Architectural");
    expect(result).toMatchSnapshot();
  });

  test("two-categories: renders in fixed priority order, not input order", () => {
    const result = RectifierPromptBuilder.firstAttemptDelta(
      [makeReviewCheck("semantic"), makeReviewCheck("typecheck")],
      3,
    );

    expect(result).toContain("## Priority 1 — Compile/build");
    expect(result).toContain("## Priority 4 — Semantic");
    expect(result.indexOf("## Priority 1 — Compile/build")).toBeLessThan(result.indexOf("## Priority 4 — Semantic"));
    expect(result).toMatchSnapshot();
  });

  test("all-categories: renders all five buckets with expected grouping", () => {
    const result = RectifierPromptBuilder.firstAttemptDelta(
      [
        makeReviewCheck("adversarial"),
        makeReviewCheck("build", { exitCode: 2 }),
        makeReviewCheck("semantic", {
          findings: [
            {
              ruleId: "semantic-ac3",
              severity: "error",
              file: "src/foo.ts",
              line: 42,
              message: "Implementation does not satisfy AC#3",
            },
          ],
        }),
        makeReviewCheck("test"),
        makeReviewCheck("lint"),
        makeReviewCheck("typecheck"),
      ],
      3,
    );

    expect(result).toContain("## Priority 1 — Compile/build");
    expect(result).toContain("### typecheck (exit 1)");
    expect(result).toContain("### build (exit 2)");
    expect(result).toContain("## Priority 2 — Lint/style");
    expect(result).toContain("## Priority 3 — Behavior");
    expect(result).toContain("## Priority 4 — Semantic");
    expect(result).toContain("## Priority 5 — Architectural");
    expect(result).toContain("Structured findings:");
    expect(result).toMatchSnapshot();
  });
});

describe("RectifierPromptBuilder.continuation", () => {
  test("single-category: renders only the matching priority bucket", () => {
    const result = RectifierPromptBuilder.continuation([makeReviewCheck("lint")], 1, 2, 3);

    expect(result).toContain("Order matters: fix Priority 1 first");
    expect(result).toContain("## Priority 2 — Lint/style");
    expect(result).not.toContain("## Priority 1 — Compile/build");
    expect(result).not.toContain("## Priority 3 — Behavior");
    expect(result).not.toContain("## Priority 4 — Semantic");
    expect(result).not.toContain("## Priority 5 — Architectural");
    expect(result).toMatchSnapshot();
  });

  test("two-categories: renders in fixed priority order, not input order", () => {
    const result = RectifierPromptBuilder.continuation(
      [makeReviewCheck("semantic"), makeReviewCheck("typecheck")],
      1,
      2,
      3,
    );

    expect(result).toContain("## Priority 1 — Compile/build");
    expect(result).toContain("## Priority 4 — Semantic");
    expect(result.indexOf("## Priority 1 — Compile/build")).toBeLessThan(result.indexOf("## Priority 4 — Semantic"));
    expect(result).toMatchSnapshot();
  });

  test("all-categories: renders all five buckets with expected grouping", () => {
    const result = RectifierPromptBuilder.continuation(
      [
        makeReviewCheck("adversarial"),
        makeReviewCheck("build", { exitCode: 2 }),
        makeReviewCheck("semantic", {
          findings: [
            {
              ruleId: "semantic-ac3",
              severity: "error",
              file: "src/foo.ts",
              line: 42,
              message: "Implementation does not satisfy AC#3",
            },
          ],
        }),
        makeReviewCheck("test"),
        makeReviewCheck("lint"),
        makeReviewCheck("typecheck"),
      ],
      3,
      2,
      3,
    );

    expect(result).toContain("## Priority 1 — Compile/build");
    expect(result).toContain("### typecheck (exit 1)");
    expect(result).toContain("### build (exit 2)");
    expect(result).toContain("## Priority 2 — Lint/style");
    expect(result).toContain("## Priority 3 — Behavior");
    expect(result).toContain("## Priority 4 — Semantic");
    expect(result).toContain("## Priority 5 — Architectural");
    expect(result).toContain("Structured findings:");
    expect(result).toContain("Rethink your approach");
    expect(result).toContain("URGENT: This is your final attempt");
    expect(result).toMatchSnapshot();
  });
});
