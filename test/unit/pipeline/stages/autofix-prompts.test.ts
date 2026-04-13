/**
 * Unit tests for src/pipeline/stages/autofix-prompts.ts
 *
 * Tests cover:
 * - Semantic-only failures produce AC-focused prompt (no "lint/typecheck" text)
 * - Mechanical-only failures produce original lint/typecheck prompt
 * - Mixed failures produce combined prompt with both sections
 * - Semantic prompt includes false-positive verification instructions
 * - Monorepo scope constraint works for all prompt variants
 * - buildDialogueAwareRectificationPrompt includes findingReasoning and dialogue history (AC4)
 */

import { describe, expect, test } from "bun:test";
import { RectifierPromptBuilder } from "../../../../src/prompts";
import type { DialogueMessage } from "../../../../src/review/dialogue";
import type { ReviewCheckResult } from "../../../../src/review/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

const STORY_BASE = {
  id: "US-010",
  title: "i18n migration",
  acceptanceCriteria: ["AC1: uses t('foo.bar')", "AC2: locale files have key"],
} as any;

const STORY_MONOREPO = {
  ...STORY_BASE,
  workdir: "apps/web",
} as any;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildReviewRectificationPrompt", () => {
  describe("semantic-only failure", () => {
    test("uses AC-focused prompt framing", () => {
      const checks = [makeCheck("semantic", "Missing key foo.bar")];
      const prompt = RectifierPromptBuilder.reviewRectification(checks, STORY_BASE);

      expect(prompt).toContain("acceptance criteria compliance issues");
      expect(prompt).toContain("AC1: uses t('foo.bar')");
      expect(prompt).toContain("AC2: locale files have key");
      expect(prompt).not.toContain("lint/typecheck errors");
    });

    test("includes false-positive verification instructions", () => {
      const checks = [makeCheck("semantic", "Key not in diff")];
      const prompt = RectifierPromptBuilder.reviewRectification(checks, STORY_BASE);

      expect(prompt).toContain("may have flagged false positives");
      expect(prompt).toContain("Read the relevant files to verify");
      expect(prompt).toContain("Do NOT add keys, functions, or imports that already exist");
    });

    test("includes scope constraint for monorepo stories", () => {
      const checks = [makeCheck("semantic", "Missing key")];
      const prompt = RectifierPromptBuilder.reviewRectification(checks, STORY_MONOREPO);

      expect(prompt).toContain("Only modify files within `apps/web/`");
    });
  });

  describe("mechanical-only failure (lint/typecheck)", () => {
    test("uses original lint/typecheck prompt framing", () => {
      const checks = [makeCheck("lint", "Unexpected console.log")];
      const prompt = RectifierPromptBuilder.reviewRectification(checks, STORY_BASE);

      expect(prompt).toContain("lint/typecheck errors");
      expect(prompt).toContain("Unexpected console.log");
      expect(prompt).not.toContain("acceptance criteria");
      expect(prompt).not.toContain("false positives");
    });

    test("includes scope constraint for monorepo stories", () => {
      const checks = [makeCheck("lint", "error")];
      const prompt = RectifierPromptBuilder.reviewRectification(checks, STORY_MONOREPO);

      expect(prompt).toContain("Only modify files within `apps/web/`");
    });

    test("excludes scope constraint for non-monorepo stories", () => {
      const checks = [makeCheck("lint", "error")];
      const prompt = RectifierPromptBuilder.reviewRectification(checks, STORY_BASE);

      expect(prompt).not.toContain("Only modify files within");
    });
  });

  describe("mixed failures (semantic + mechanical)", () => {
    test("combines both sections", () => {
      const checks = [
        makeCheck("lint", "console.log found"),
        makeCheck("semantic", "AC not implemented"),
      ];
      const prompt = RectifierPromptBuilder.reviewRectification(checks, STORY_BASE);

      expect(prompt).toContain("Lint/Typecheck Errors");
      expect(prompt).toContain("console.log found");
      expect(prompt).toContain("Semantic Review Findings");
      expect(prompt).toContain("AC not implemented");
      expect(prompt).toContain("AC1: uses t('foo.bar')");
      expect(prompt).toContain("false positives");
    });

    test("includes scope constraint for monorepo", () => {
      const checks = [
        makeCheck("lint", "error"),
        makeCheck("semantic", "missing key"),
      ];
      const prompt = RectifierPromptBuilder.reviewRectification(checks, STORY_MONOREPO);

      expect(prompt).toContain("Only modify files within `apps/web/`");
    });
  });
});

// ---------------------------------------------------------------------------
// AC4: buildDialogueAwareRectificationPrompt
// ---------------------------------------------------------------------------

describe("buildDialogueAwareRectificationPrompt (AC4)", () => {
  const FAILED_CHECKS_SEMANTIC = [makeCheck("semantic", "AC2 not implemented")];

  test("is exported from src/prompts", () => {
    expect(typeof RectifierPromptBuilder.dialogueAwareRectification).toBe("function");
  });

  test("includes findingReasoning entries in the prompt", () => {
    const findingReasoning = new Map<string, string>([
      ["AC1", "AC1 is missing because the handler doesn't call saveUser()"],
      ["AC2", "AC2 fails because the response format is wrong"],
    ]);

    const prompt = RectifierPromptBuilder.dialogueAwareRectification(FAILED_CHECKS_SEMANTIC, STORY_BASE, {
      findingReasoning,
      history: [],
    });

    expect(prompt).toContain("AC1");
    expect(prompt).toContain("AC1 is missing because the handler doesn't call saveUser()");
    expect(prompt).toContain("AC2");
    expect(prompt).toContain("AC2 fails because the response format is wrong");
  });

  test("includes the last N dialogue history messages", () => {
    const history: DialogueMessage[] = [
      { role: "implementer", content: "First implementer message" },
      { role: "reviewer", content: "First reviewer response" },
      { role: "implementer", content: "Second implementer message" },
      { role: "reviewer", content: "Second reviewer response" },
    ];

    const prompt = RectifierPromptBuilder.dialogueAwareRectification(FAILED_CHECKS_SEMANTIC, STORY_BASE, {
      findingReasoning: new Map(),
      history,
      maxHistoryMessages: 2,
    });

    // Should include the last 2 messages
    expect(prompt).toContain("Second implementer message");
    expect(prompt).toContain("Second reviewer response");
  });

  test("omits older history messages beyond maxHistoryMessages", () => {
    const history: DialogueMessage[] = [
      { role: "implementer", content: "Old implementer message from round 1" },
      { role: "reviewer", content: "Old reviewer response from round 1" },
      { role: "implementer", content: "Recent implementer message" },
      { role: "reviewer", content: "Recent reviewer response" },
    ];

    const prompt = RectifierPromptBuilder.dialogueAwareRectification(FAILED_CHECKS_SEMANTIC, STORY_BASE, {
      findingReasoning: new Map(),
      history,
      maxHistoryMessages: 2,
    });

    // Older messages should NOT be included
    expect(prompt).not.toContain("Old implementer message from round 1");
    expect(prompt).not.toContain("Old reviewer response from round 1");
  });

  test("works with empty findingReasoning and empty history", () => {
    const prompt = RectifierPromptBuilder.dialogueAwareRectification(FAILED_CHECKS_SEMANTIC, STORY_BASE, {
      findingReasoning: new Map(),
      history: [],
    });

    // Should still produce a valid prompt
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain(STORY_BASE.id);
  });

  test("includes failed check output alongside reasoning", () => {
    const findingReasoning = new Map<string, string>([
      ["AC1", "The handler is missing"],
    ]);

    const prompt = RectifierPromptBuilder.dialogueAwareRectification(FAILED_CHECKS_SEMANTIC, STORY_BASE, {
      findingReasoning,
      history: [],
    });

    // The check output should appear
    expect(prompt).toContain("AC2 not implemented");
    // And the reasoning should also appear
    expect(prompt).toContain("The handler is missing");
  });

  test("includes scope constraint for monorepo stories", () => {
    const prompt = RectifierPromptBuilder.dialogueAwareRectification(FAILED_CHECKS_SEMANTIC, STORY_MONOREPO, {
      findingReasoning: new Map(),
      history: [],
    });

    expect(prompt).toContain("Only modify files within `apps/web/`");
  });
});
