/**
 * Unit tests for src/pipeline/stages/autofix-prompts.ts
 *
 * Tests cover:
 * - Semantic-only failures produce AC-focused prompt (no "lint/typecheck" text)
 * - Mechanical-only failures produce original lint/typecheck prompt
 * - Mixed failures produce combined prompt with both sections
 * - Semantic prompt includes false-positive verification instructions
 * - Monorepo scope constraint works for all prompt variants
 */

import { describe, expect, test } from "bun:test";
import { buildReviewRectificationPrompt } from "../../../../src/pipeline/stages/autofix-prompts";
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
      const prompt = buildReviewRectificationPrompt(checks, STORY_BASE);

      expect(prompt).toContain("acceptance criteria compliance issues");
      expect(prompt).toContain("AC1: uses t('foo.bar')");
      expect(prompt).toContain("AC2: locale files have key");
      expect(prompt).not.toContain("lint/typecheck errors");
    });

    test("includes false-positive verification instructions", () => {
      const checks = [makeCheck("semantic", "Key not in diff")];
      const prompt = buildReviewRectificationPrompt(checks, STORY_BASE);

      expect(prompt).toContain("may have flagged false positives");
      expect(prompt).toContain("Read the relevant files to verify");
      expect(prompt).toContain("Do NOT add keys, functions, or imports that already exist");
    });

    test("includes scope constraint for monorepo stories", () => {
      const checks = [makeCheck("semantic", "Missing key")];
      const prompt = buildReviewRectificationPrompt(checks, STORY_MONOREPO);

      expect(prompt).toContain("Only modify files within `apps/web/`");
    });
  });

  describe("mechanical-only failure (lint/typecheck)", () => {
    test("uses original lint/typecheck prompt framing", () => {
      const checks = [makeCheck("lint", "Unexpected console.log")];
      const prompt = buildReviewRectificationPrompt(checks, STORY_BASE);

      expect(prompt).toContain("lint/typecheck errors");
      expect(prompt).toContain("Unexpected console.log");
      expect(prompt).not.toContain("acceptance criteria");
      expect(prompt).not.toContain("false positives");
    });

    test("includes scope constraint for monorepo stories", () => {
      const checks = [makeCheck("lint", "error")];
      const prompt = buildReviewRectificationPrompt(checks, STORY_MONOREPO);

      expect(prompt).toContain("Only modify files within `apps/web/`");
    });

    test("excludes scope constraint for non-monorepo stories", () => {
      const checks = [makeCheck("lint", "error")];
      const prompt = buildReviewRectificationPrompt(checks, STORY_BASE);

      expect(prompt).not.toContain("Only modify files within");
    });
  });

  describe("mixed failures (semantic + mechanical)", () => {
    test("combines both sections", () => {
      const checks = [
        makeCheck("lint", "console.log found"),
        makeCheck("semantic", "AC not implemented"),
      ];
      const prompt = buildReviewRectificationPrompt(checks, STORY_BASE);

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
      const prompt = buildReviewRectificationPrompt(checks, STORY_MONOREPO);

      expect(prompt).toContain("Only modify files within `apps/web/`");
    });
  });
});
