/**
 * Unit tests for RectifierPromptBuilder.reviewRectification — label routing.
 *
 * Tests cover:
 * - Adversarial-only failure uses "adversarial review" language, not "semantic review"
 * - Semantic-only failure uses "semantic review" language
 * - Combined semantic + adversarial failure uses distinct sections for each
 * - Mechanical-only failure uses mechanical language
 * - Mixed LLM + mechanical prompt uses "LLM Review Findings", not "Semantic Review Findings"
 */

import { describe, expect, test } from "bun:test";
import { RectifierPromptBuilder } from "@/prompts/builders/rectifier-builder";
import type { ReviewCheckResult } from "@/review/types";
import { makeFinding } from "@test/helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCheck(check: ReviewCheckResult["check"], output: string): ReviewCheckResult {
  return {
    check,
    success: false,
    command: `${check}-cmd`,
    exitCode: 1,
    output,
    durationMs: 100,
  };
}

const STORY = {
  id: "US-001",
  title: "Add auth",
  acceptanceCriteria: ["Users can log in", "Invalid credentials are rejected"],
} as any;

// ---------------------------------------------------------------------------
// Adversarial-only failure
// ---------------------------------------------------------------------------

describe("RectifierPromptBuilder.reviewRectification — adversarial-only", () => {
  test("does NOT say 'semantic review' when only adversarial check failed", () => {
    const checks = [makeCheck("adversarial", "Missing error-path handling")];
    const prompt = RectifierPromptBuilder.reviewRectification(checks, STORY);

    expect(prompt).not.toContain("semantic review");
    expect(prompt).not.toContain("Semantic Review Findings");
    expect(prompt).not.toContain("semantic reviewer");
  });

  test("says 'adversarial' when only adversarial check failed", () => {
    const checks = [makeCheck("adversarial", "Missing error-path handling")];
    const prompt = RectifierPromptBuilder.reviewRectification(checks, STORY);

    expect(prompt).toContain("adversarial");
  });

  test("includes 'Adversarial Review Findings' section header", () => {
    const checks = [makeCheck("adversarial", "Missing error-path handling")];
    const prompt = RectifierPromptBuilder.reviewRectification(checks, STORY);

    expect(prompt).toContain("Adversarial Review Findings");
  });

  test("includes the finding output", () => {
    const checks = [makeCheck("adversarial", "Missing error-path handling")];
    const prompt = RectifierPromptBuilder.reviewRectification(checks, STORY);

    expect(prompt).toContain("Missing error-path handling");
  });

  test("includes acceptance criteria", () => {
    const checks = [makeCheck("adversarial", "edge case missing")];
    const prompt = RectifierPromptBuilder.reviewRectification(checks, STORY);

    expect(prompt).toContain("Users can log in");
    expect(prompt).toContain("Invalid credentials are rejected");
  });
});

// ---------------------------------------------------------------------------
// Semantic-only failure
// ---------------------------------------------------------------------------

describe("RectifierPromptBuilder.reviewRectification — semantic-only", () => {
  test("says 'semantic review' when only semantic check failed", () => {
    const checks = [makeCheck("semantic", "AC-1 not implemented")];
    const prompt = RectifierPromptBuilder.reviewRectification(checks, STORY);

    expect(prompt).toContain("semantic review");
  });

  test("includes 'Semantic Review Findings' section header", () => {
    const checks = [makeCheck("semantic", "AC-1 not implemented")];
    const prompt = RectifierPromptBuilder.reviewRectification(checks, STORY);

    expect(prompt).toContain("Semantic Review Findings");
  });

  test("does NOT say 'adversarial' when only semantic check failed", () => {
    const checks = [makeCheck("semantic", "AC-1 not implemented")];
    const prompt = RectifierPromptBuilder.reviewRectification(checks, STORY);

    expect(prompt.toLowerCase()).not.toContain("adversarial review findings");
  });
});

// ---------------------------------------------------------------------------
// Combined semantic + adversarial failure
// ---------------------------------------------------------------------------

describe("RectifierPromptBuilder.reviewRectification — semantic + adversarial", () => {
  test("includes both 'Semantic Review Findings' and 'Adversarial Review Findings' sections", () => {
    const checks = [
      makeCheck("semantic", "AC-1 not implemented"),
      makeCheck("adversarial", "Missing error-path handling"),
    ];
    const prompt = RectifierPromptBuilder.reviewRectification(checks, STORY);

    expect(prompt).toContain("Semantic Review Findings");
    expect(prompt).toContain("Adversarial Review Findings");
  });

  test("includes findings from both checks", () => {
    const checks = [
      makeCheck("semantic", "AC-1 not implemented"),
      makeCheck("adversarial", "Missing error-path handling"),
    ];
    const prompt = RectifierPromptBuilder.reviewRectification(checks, STORY);

    expect(prompt).toContain("AC-1 not implemented");
    expect(prompt).toContain("Missing error-path handling");
  });
});

// ---------------------------------------------------------------------------
// Mixed LLM + mechanical failure
// ---------------------------------------------------------------------------

describe("RectifierPromptBuilder.reviewRectification — adversarial + mechanical", () => {
  test("does NOT say 'Semantic Review Findings (AC Compliance)' when adversarial + lint both fail", () => {
    const checks = [makeCheck("adversarial", "Missing error handling"), makeCheck("lint", "Unused variable")];
    const prompt = RectifierPromptBuilder.reviewRectification(checks, STORY);

    expect(prompt).not.toContain("Semantic Review Findings (AC Compliance)");
    expect(prompt).not.toContain("semantic reviewer");
  });

  test("uses 'LLM Review Findings' section for the adversarial part", () => {
    const checks = [makeCheck("adversarial", "Missing error handling"), makeCheck("lint", "Unused variable")];
    const prompt = RectifierPromptBuilder.reviewRectification(checks, STORY);

    expect(prompt).toContain("Adversarial Review Findings");
  });

  test("includes both lint and adversarial output in mixed prompt", () => {
    const checks = [makeCheck("adversarial", "Missing error handling"), makeCheck("lint", "Unused variable")];
    const prompt = RectifierPromptBuilder.reviewRectification(checks, STORY);

    expect(prompt).toContain("Missing error handling");
    expect(prompt).toContain("Unused variable");
  });
});

// ---------------------------------------------------------------------------
// Mechanical-only failure (regression guard)
// ---------------------------------------------------------------------------

describe("RectifierPromptBuilder.reviewRectification — mechanical-only regression", () => {
  test("uses mechanical language when only lint fails", () => {
    const checks = [makeCheck("lint", "Unused variable")];
    const prompt = RectifierPromptBuilder.reviewRectification(checks, STORY);

    expect(prompt).toContain("lint/typecheck");
    expect(prompt).not.toContain("semantic review");
    expect(prompt.toLowerCase()).not.toContain("adversarial review findings");
  });

  test("renders structured findings before raw output for mechanical checks", () => {
    const checks: ReviewCheckResult[] = [
      {
        ...makeCheck("lint", "src/foo.ts:1:1 raw lint line"),
        findings: [
          makeFinding({
            source: "lint",
            rule: "lint/rule",
            severity: "error",
            file: "src/foo.ts",
            line: 1,
            message: "Structured lint issue",
          }),
        ],
      },
    ];
    const prompt = RectifierPromptBuilder.reviewRectification(checks, STORY);

    const structuredIdx = prompt.indexOf("Structured findings:");
    const rawIdx = prompt.indexOf("Raw output excerpt:");
    expect(structuredIdx).toBeGreaterThan(-1);
    expect(rawIdx).toBeGreaterThan(-1);
    expect(structuredIdx).toBeLessThan(rawIdx);
  });

  test("caps raw output excerpt when structured findings exist", () => {
    const hugeOutput = `{${"x".repeat(10_000)}}`;
    const checks: ReviewCheckResult[] = [
      {
        ...makeCheck("lint", hugeOutput),
        findings: [
          makeFinding({
            source: "lint",
            rule: "lint/rule",
            severity: "error",
            file: "src/foo.ts",
            line: 1,
            message: "Structured lint issue",
          }),
        ],
      },
    ];
    const prompt = RectifierPromptBuilder.reviewRectification(checks, STORY);
    expect(prompt).toContain("truncated");
    const xCount = (prompt.match(/x/g) ?? []).length;
    expect(xCount).toBeLessThan(10_000);
  });

  test("uses blockingThreshold mapping for structured findings", () => {
    const checks: ReviewCheckResult[] = [
      {
        ...makeCheck("semantic", "raw semantic output"),
        findings: [
          makeFinding({
            source: "semantic-review",
            rule: "semantic/rule",
            severity: "warning",
            file: "src/foo.ts",
            line: 12,
            message: "Warning-level finding",
          }),
        ],
      },
    ];

    const promptDefault = RectifierPromptBuilder.reviewRectification(checks, STORY);
    expect(promptDefault).not.toContain("Structured findings:");

    const promptWarning = RectifierPromptBuilder.reviewRectification(checks, STORY, {
      blockingThreshold: "warning",
    });
    expect(promptWarning).toContain("Structured findings:");
    expect(promptWarning).toContain("Warning-level finding");
  });
});
