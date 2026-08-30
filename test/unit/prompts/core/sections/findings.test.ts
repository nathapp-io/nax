/**
 * Tests for findingsSection() in src/prompts/core/sections/findings.ts
 *
 * Builds the "REVIEW FINDINGS" section used by RectifierPromptBuilder (Phase 5).
 */

import { describe, expect, test } from "bun:test";
import type { ReviewFinding } from "@/plugins/types";
import { findingsSection } from "@/prompts/core/sections/findings";

function makeFinding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    ruleId: "no-unused-vars",
    severity: "warning",
    file: "src/foo.ts",
    line: 10,
    message: "unused variable 'x'",
    ...overrides,
  };
}

describe("findingsSection()", () => {
  test("returns null for an empty findings array", () => {
    expect(findingsSection([])).toBeNull();
  });

  test("returns a PromptSection with id 'findings' for non-empty input", () => {
    const result = findingsSection([makeFinding()]);
    expect(result).not.toBeNull();
    expect(result?.id).toBe("findings");
    expect(result?.overridable).toBe(false);
  });

  test("includes the REVIEW FINDINGS header", () => {
    const result = findingsSection([makeFinding()]);
    expect(result?.content).toContain("# REVIEW FINDINGS");
  });

  test("includes severity, rule id, file, line and message for a single finding", () => {
    const result = findingsSection([
      makeFinding({ severity: "critical", ruleId: "no-eval", file: "src/bar.ts", line: 42, message: "eval used" }),
    ]);

    expect(result?.content).toContain("## Finding 1 — CRITICAL: no-eval");
    expect(result?.content).toContain("File: src/bar.ts:42");
    expect(result?.content).toContain("Message: eval used");
  });

  test("numbers multiple findings sequentially", () => {
    const result = findingsSection([makeFinding({ ruleId: "rule-a" }), makeFinding({ ruleId: "rule-b" })]);

    expect(result?.content).toContain("## Finding 1 — WARNING: rule-a");
    expect(result?.content).toContain("## Finding 2 — WARNING: rule-b");
  });
});
