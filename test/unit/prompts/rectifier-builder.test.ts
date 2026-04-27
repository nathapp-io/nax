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
