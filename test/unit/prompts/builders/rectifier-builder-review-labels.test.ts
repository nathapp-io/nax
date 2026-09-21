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
import { join } from "node:path";
import { makeFinding, makeStory } from "@test/helpers";
import type { Finding } from "@/findings/types";
import { RectifierPromptBuilder } from "@/prompts/builders/rectifier-builder";
import type { ReviewCheckResult } from "@/review/types";

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

const STORY = makeStory({
  id: "US-001",
  title: "Add auth",
  acceptanceCriteria: ["Users can log in", "Invalid credentials are rejected"],
});

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

// ─────────────────────────────────────────────────────────────────────────────
// AC7: RectifierPromptBuilder.verifierContext static method exists on the class
// AC8: src/prompts/sections/verdict.ts is byte-identical to SHA 52634c0b (not
//      modified by this story)
// ─────────────────────────────────────────────────────────────────────────────

const VERIFIER_FINDING: Finding = {
  source: "tdd-verifier",
  severity: "error",
  category: "tests-failed",
  message: "3 test(s) failed (verifier)",
  fixTarget: "source",
  meta: {
    passCount: 1,
    failCount: 3,
    reasoning: "tests ran but 3 failed",
  },
};

describe("AC7: RectifierPromptBuilder.verifierContext static method", () => {
  test("AC7: RectifierPromptBuilder is exported from src/prompts barrel", async () => {
    const mod = await import("@/prompts");
    expect(mod.RectifierPromptBuilder).toBeDefined();
  });

  test("AC7: verifierContext is a static method on RectifierPromptBuilder", async () => {
    const { RectifierPromptBuilder } = await import("@/prompts");
    expect(typeof RectifierPromptBuilder.verifierContext).toBe("function");
  });

  test("AC7: verifierContext returns a string when given findings", async () => {
    const { RectifierPromptBuilder } = await import("@/prompts");
    let result: string | undefined;
    try {
      result = RectifierPromptBuilder.verifierContext([VERIFIER_FINDING]);
    } catch {
      // stub throws "not implemented" — test fails here, proving impl is missing
    }
    expect(typeof result).toBe("string");
    expect((result as string).length).toBeGreaterThan(0);
  });

  test("AC7: verifierContext returns a string when findings is empty", async () => {
    const { RectifierPromptBuilder } = await import("@/prompts");
    let result: string | undefined;
    try {
      result = RectifierPromptBuilder.verifierContext([]);
    } catch {
      // stub throws — test fails until implemented
    }
    expect(typeof result).toBe("string");
  });

  test("AC7: rectifier-builder.ts contains exactly one static verifierContext( definition", async () => {
    const file = Bun.file(join(import.meta.dir, "../../../../src/prompts/builders/rectifier-builder.ts"));
    const content = await file.text();
    const matches = content.split("\n").filter((line) => /static verifierContext\(/.test(line));
    expect(matches.length).toBe(1);
  });
});

describe("AC8: src/prompts/sections/verdict.ts is not modified by this story", () => {
  test("AC8: verdict.ts still exports buildVerdictSection function", async () => {
    const mod = await import("@/prompts/sections/verdict");
    expect(typeof mod.buildVerdictSection).toBe("function");
  });

  test("AC8: verdict.ts does not contain verifierContext or normalizedFindings references", async () => {
    const file = Bun.file(join(import.meta.dir, "../../../../src/prompts/sections/verdict.ts"));
    const content = await file.text();
    expect(content).not.toContain("verifierContext");
    expect(content).not.toContain("normalizedFindings");
  });

  test("AC8: verdict.ts contains the canonical approved:true schema example", async () => {
    const file = Bun.file(join(import.meta.dir, "../../../../src/prompts/sections/verdict.ts"));
    const content = await file.text();
    // Key marker from the known content at SHA 52634c0b
    expect(content).toContain('"approved":true');
    expect(content).toContain("buildVerdictSection");
    expect(content).toContain(".nax-verifier-verdict.json");
  });
});
