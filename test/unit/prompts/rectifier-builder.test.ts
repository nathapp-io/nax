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
import type { Finding } from "@/findings/types";
import { RectifierPromptBuilder, repoScopedRectification } from "@/prompts";
import type { FailureRecord } from "@/prompts";
import type { ReviewCheckResult } from "@/review/types";
import { makeFinding, makeStory } from "@test/helpers";

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
  test("includes story title, description, acceptance criteria, failure messages, and test command", () => {
    const result = RectifierPromptBuilder.regressionFailure({
      story: STORY,
      failures: FAILURES,
      testCommand: TEST_CMD,
    });
    expect(result).toContain(STORY.title);
    expect(result).toContain(STORY.description);
    for (const ac of STORY.acceptanceCriteria) expect(result).toContain(ac);
    for (const f of FAILURES) expect(result).toContain(f.message);
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

  test("includes conventions by default; omits conventions section when disabled", () => {
    const withConventions = RectifierPromptBuilder.regressionFailure({
      story: STORY,
      failures: FAILURES,
      testCommand: TEST_CMD,
    });
    expect(withConventions).toContain("Conventions");
    const noConventions = RectifierPromptBuilder.regressionFailure({
      story: STORY,
      failures: FAILURES,
      testCommand: TEST_CMD,
      conventions: false,
    });
    expect(noConventions.split("\n").some((l) => l.startsWith("# Conventions"))).toBe(false);
  });

  test("includes isolation, context, constitution, and promptPrefix when provided", () => {
    const result = RectifierPromptBuilder.regressionFailure({
      story: STORY,
      failures: FAILURES,
      testCommand: TEST_CMD,
      isolation: "strict",
      context: CONTEXT,
      constitution: "# Constitution\n\nFollow these rules.",
      promptPrefix: "DIAGNOSTIC: Retrying after escalation.",
    });
    expect(result).toContain("Isolation");
    expect(result).toContain("Project Context");
    expect(result).toContain("Follow these rules");
    expect(result).toContain("DIAGNOSTIC: Retrying after escalation.");
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

  test("contains the core no-op directive, UNRESOLVED escape hatch, and no TS-specific names", () => {
    const result = RectifierPromptBuilder.noOpReprompt([FAILED_CHECK], 0, 1);
    expect(result).toContain("no committed file changes");
    expect(result).toContain("UNRESOLVED");
    expect(result).toContain("commit");
    expect(result).not.toContain("`package.json`");
    expect(result).not.toContain("`tsconfig.json`");
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
            makeFinding({
              rule: "semantic-ac3",
              severity: "error",
              file: "src/foo.ts",
              line: 42,
              message: "Implementation does not satisfy AC#3",
            }),
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
            makeFinding({
              rule: "semantic-ac3",
              severity: "error",
              file: "src/foo.ts",
              line: 42,
              message: "Implementation does not satisfy AC#3",
            }),
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

// ─── repoScopedRectification (#1654) ─────────────────────────────────────────
//
// The mandate handed to the fallthrough claimant after the story-scoped
// rectifier declined a failing test as out-of-scope. Its job is to remove the
// contradiction that produced the refusal — "fix this test, but do not touch
// what is broken" — without removing the test-integrity rules alongside it.

describe("repoScopedRectification", () => {
  const failing: Finding = {
    source: "test-runner",
    severity: "error",
    category: "failed-test",
    rule: "computes the median",
    file: "test/unit/stats.test.ts",
    message: "AssertionError: expected 3 to be 4",
  };

  test("names the failing test so the agent knows what it is fixing", () => {
    const prompt = repoScopedRectification([failing], STORY);
    expect(prompt).toContain("test/unit/stats.test.ts");
    expect(prompt).toContain("computes the median");
  });

  test("drops the sibling-scope exception that tells the agent to punt", () => {
    // Exception 3 instructs the agent to declare `sibling_scope` and continue,
    // on the grounds that out-of-scope failures do not block the story. That is
    // the exact instruction this dispatch exists to override; leaving it in
    // would re-license the refusal we are responding to.
    const prompt = repoScopedRectification([failing], STORY);
    expect(prompt).not.toContain("sibling_scope");
    expect(RectifierPromptBuilder.failingTestRectification([failing], STORY)).toContain("sibling_scope");
  });

  test("states that out-of-scope is not a reason to decline", () => {
    const prompt = repoScopedRectification([failing], STORY);
    expect(prompt.toLowerCase()).toContain("not a reason to decline");
  });

  test("keeps the UNRESOLVED protocol for genuinely unsatisfiable tests", () => {
    expect(repoScopedRectification([failing], STORY)).toContain("UNRESOLVED:");
  });

  test("keeps the prohibition on weakening tests", () => {
    // An agent authorised to edit any file is precisely the one that must not be
    // authorised to make a red test green by deleting its assertion.
    const prompt = repoScopedRectification([failing], STORY);
    expect(prompt).toContain("TEST_EDIT_REASON");
    expect(prompt.toLowerCase()).toContain("weaken");
  });

  test("routes a nondeterministic failure to UNRESOLVED rather than to a fix", () => {
    // Flake triage normally quarantines these before rectification, but it has
    // skip paths (probe cap exceeded, unresolvable baseline diff, framework not
    // detected) that leave a flaky test looking deterministic. An agent
    // authorised to edit any file and told to make the test pass is the worst
    // possible reader of a test that fails at random — it will weaken it. Name
    // the case and give it the terminal channel instead.
    const prompt = repoScopedRectification([failing], STORY);
    expect(prompt.toLowerCase()).toContain("flaky");
  });

  test("the stated exception count matches the exceptions actually present", () => {
    // buildEscapeHatch interpolates the exception count into its prose and the
    // headings are numbered literals, so dropping one without adjusting the set
    // yields a prompt that numbers its exceptions 1, 2, 4 while telling the agent
    // to check "Exceptions 1-3".
    const prompt = repoScopedRectification([failing], STORY);
    const headings = prompt.match(/^### Exception (\d+) —/gm) ?? [];
    expect(headings.length).toBeGreaterThan(0);
    expect(prompt).toContain(`Exceptions 1\u2013${headings.length}`);
    expect(headings.map((h) => h.match(/\d+/)?.[0])).toEqual(
      Array.from({ length: headings.length }, (_, i) => String(i + 1)),
    );
  });
});
