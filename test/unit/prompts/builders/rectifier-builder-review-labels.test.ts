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
import { RectifierPromptBuilder } from "../../../../src/prompts/builders/rectifier-builder";
import type { ReviewCheckResult } from "../../../../src/review/types";

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

    expect(prompt.toLowerCase()).not.toContain("adversarial");
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
    const checks = [
      makeCheck("adversarial", "Missing error handling"),
      makeCheck("lint", "Unused variable"),
    ];
    const prompt = RectifierPromptBuilder.reviewRectification(checks, STORY);

    expect(prompt).not.toContain("Semantic Review Findings (AC Compliance)");
    expect(prompt).not.toContain("semantic reviewer");
  });

  test("uses 'LLM Review Findings' section for the adversarial part", () => {
    const checks = [
      makeCheck("adversarial", "Missing error handling"),
      makeCheck("lint", "Unused variable"),
    ];
    const prompt = RectifierPromptBuilder.reviewRectification(checks, STORY);

    expect(prompt).toContain("Adversarial Review Findings");
  });

  test("includes both lint and adversarial output in mixed prompt", () => {
    const checks = [
      makeCheck("adversarial", "Missing error handling"),
      makeCheck("lint", "Unused variable"),
    ];
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
    expect(prompt.toLowerCase()).not.toContain("adversarial");
  });
});
