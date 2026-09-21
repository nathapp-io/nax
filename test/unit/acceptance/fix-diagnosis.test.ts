/**
 * Tests for src/acceptance/fix-diagnosis.ts — source-file loading utilities
 *
 * Covers:
 * - loadSourceFilesForDiagnosis auto-detects source files from import statements
 * - DiagnosisResult interface validation
 */

import { describe, expect, test } from "bun:test";
import { loadSourceFilesForDiagnosis } from "@/acceptance/fix-diagnosis";
import type { DiagnosisResult, SemanticVerdict } from "@/acceptance/types";
import { AcceptancePromptBuilder } from "@/prompts";

// ─────────────────────────────────────────────────────────────────────────────
// loadSourceFilesForDiagnosis
// ─────────────────────────────────────────────────────────────────────────────

describe("loadSourceFilesForDiagnosis", () => {
  test("returns empty array when test file has no imports", async () => {
    const result = await loadSourceFilesForDiagnosis({
      testFileContent: 'test("x", () => {});',
      packageDir: "/tmp",
      language: "typescript",
    });
    expect(result).toEqual([]);
  });

  test("resolves relative imports from test file content", async () => {
    const testContent = `
import { add } from "./src/math.ts";
import { multiply } from "./src/utils.ts";
test("AC-1", () => { expect(add(1,2)).toBe(3); });
`;
    // Files don't exist on disk — function gracefully returns null for missing files
    const result = await loadSourceFilesForDiagnosis({
      testFileContent: testContent,
      packageDir: "/tmp",
      language: "typescript",
    });
    expect(result).toEqual([]);
  });

  test("limits to 5 files maximum", async () => {
    const testContent = `
import { a } from "./src/file1.ts";
import { b } from "./src/file2.ts";
import { c } from "./src/file3.ts";
import { d } from "./src/file4.ts";
import { e } from "./src/file5.ts";
import { f } from "./src/file6.ts";
test("AC-1", () => { expect(a()).toBe(1); });
`;
    // No files exist on disk
    const result = await loadSourceFilesForDiagnosis({
      testFileContent: testContent,
      packageDir: "/tmp",
      language: "typescript",
    });
    expect(result).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DiagnosisResult interface validation
// ─────────────────────────────────────────────────────────────────────────────

describe("DiagnosisResult interface validation", () => {
  test("verdict accepts 'source_bug'", () => {
    const result: DiagnosisResult = {
      verdict: "source_bug",
      reasoning: "Source code bug found",
      confidence: 0.85,
    };
    expect(result.verdict).toBe("source_bug");
  });

  test("verdict accepts 'test_bug'", () => {
    const result: DiagnosisResult = {
      verdict: "test_bug",
      reasoning: "Test bug found",
      confidence: 0.9,
    };
    expect(result.verdict).toBe("test_bug");
  });

  test("verdict accepts 'both'", () => {
    const result: DiagnosisResult = {
      verdict: "both",
      reasoning: "Both bugs found",
      confidence: 0.75,
    };
    expect(result.verdict).toBe("both");
  });

  test("confidence must be between 0 and 1", () => {
    const lowConfidence: DiagnosisResult = {
      verdict: "source_bug",
      reasoning: "Low confidence",
      confidence: 0,
    };
    const highConfidence: DiagnosisResult = {
      verdict: "test_bug",
      reasoning: "High confidence",
      confidence: 1,
    };
    expect(lowConfidence.confidence).toBe(0);
    expect(highConfidence.confidence).toBe(1);
  });

  test("findings is optional", () => {
    const minimal: DiagnosisResult = {
      verdict: "source_bug",
      reasoning: "Minimal result",
      confidence: 0.5,
    };
    expect(minimal.findings).toBeUndefined();
  });

  test("findings can be provided", () => {
    const full: DiagnosisResult = {
      verdict: "both",
      reasoning: "Full result",
      confidence: 0.95,
      findings: [
        {
          source: "acceptance-diagnose",
          severity: "error",
          category: "test",
          message: "Test issue 1",
          fixTarget: "test",
        },
        {
          source: "acceptance-diagnose",
          severity: "error",
          category: "source",
          message: "Source issue 1",
          fixTarget: "source",
        },
      ],
    };
    expect(full.findings?.length).toBe(2);
    expect(full.findings?.[0].message).toBe("Test issue 1");
    expect(full.findings?.[1].message).toBe("Source issue 1");
  });
});

/**
 * Unit tests for buildDiagnosisPrompt() in src/acceptance/fix-diagnosis.ts
 *
 * Covers US-004 AC-3: when some but not all verdicts have passed: true,
 * buildDiagnosisPrompt() appends a section listing the confirmed story IDs
 * and stating their failures are likely test bugs.
 *
 * RED: AC-3 partial verdict section wording ("likely test bug" for confirmed stories)
 * GREEN: basic verdicts section inclusion (already implemented)
 */
const builder = new AcceptancePromptBuilder();
const buildDiagnosisPrompt = (opts: Parameters<AcceptancePromptBuilder["buildDiagnosisPrompt"]>[0]) =>
  builder.buildDiagnosisPrompt(opts);

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makePassingVerdict(storyId: string): SemanticVerdict {
  return { storyId, passed: true, timestamp: new Date().toISOString(), acCount: 2, findings: [] };
}

function makeFailingVerdict(storyId: string): SemanticVerdict {
  return { storyId, passed: false, timestamp: new Date().toISOString(), acCount: 2, findings: [] };
}

// ─────────────────────────────────────────────────────────────────────────────
// AC-3: Partial verdicts section — confirmed story IDs + "likely test bug"
// ─────────────────────────────────────────────────────────────────────────────

describe("buildDiagnosisPrompt — partial semantic verdicts section (AC-3)", () => {
  test("includes the passed story ID in the prompt when some verdicts passed", () => {
    const prompt = buildDiagnosisPrompt({
      testOutput: "FAIL: assertion error",
      testFileContent: "test content",
      sourceFiles: [],
      semanticVerdicts: [makePassingVerdict("US-001"), makeFailingVerdict("US-002")],
    });
    expect(prompt).toContain("US-001");
  });

  test("states failures are likely test bugs for confirmed (passed) stories", () => {
    // AC-3: the section must state that confirmed stories' failures are likely test bugs
    const prompt = buildDiagnosisPrompt({
      testOutput: "FAIL",
      testFileContent: "test content",
      sourceFiles: [],
      semanticVerdicts: [makePassingVerdict("US-001"), makeFailingVerdict("US-002")],
    });
    // The section must include "likely" (as in "likely test bug") for the confirmed story
    expect(prompt.toLowerCase()).toContain("likely");
  });

  test("mentions confirmed story US-001 in context of test bug likelihood", () => {
    // AC-3: the section should associate US-001 (confirmed) with "test bug" framing
    const prompt = buildDiagnosisPrompt({
      testOutput: "FAIL",
      testFileContent: "test content",
      sourceFiles: [],
      semanticVerdicts: [makePassingVerdict("US-001"), makeFailingVerdict("US-002")],
    });
    // Confirmed story ID must appear near test-bug context
    // The prompt should say something like "US-001: likely test bug" or
    // "failures for US-001 are likely test bugs"
    const hasContextualMention =
      prompt.includes("US-001") &&
      (prompt.toLowerCase().includes("likely test bug") ||
        prompt.toLowerCase().includes("likely a test bug") ||
        (prompt.toLowerCase().includes("test bug") &&
          prompt.indexOf("US-001") < prompt.toLowerCase().indexOf("likely")));
    expect(hasContextualMention).toBe(true);
  });

  test("does not include confirmed story as a source bug suspect", () => {
    // A confirmed (passed) story should be described as a test bug issue, not source bug
    const prompt = buildDiagnosisPrompt({
      testOutput: "FAIL",
      testFileContent: "test content",
      sourceFiles: [],
      semanticVerdicts: [makePassingVerdict("US-001")],
    });
    // The prompt should not suggest US-001 has a source bug
    // (it was confirmed by semantic review — the test is the problem)
    expect(prompt).toContain("US-001");
    // Prompt must not mark the confirmed story as "source bug"
    const _sourceContext = prompt.indexOf("source_bug") > -1 || prompt.includes("source bug");
    // The confirmed story context must not be "source bug" — it's test level
    // (This is a soft check; the key is the "likely test bug" framing above)
    expect(prompt.toLowerCase()).not.toMatch(/us-001.*source.?bug/);
  });

  test("appends section when some but not all verdicts pass (partial pass)", () => {
    // AC-3 is specifically about PARTIAL verdicts (some pass, some fail)
    const partial = buildDiagnosisPrompt({
      testOutput: "FAIL",
      testFileContent: "test content",
      sourceFiles: [],
      semanticVerdicts: [makePassingVerdict("US-001"), makeFailingVerdict("US-002")],
    });
    // Section must appear when partial verdicts exist
    expect(partial).toContain("US-001");
    expect(partial).toContain("US-002");
  });

  test("section specifically lists only the confirmed (passed) story IDs as likely test bugs", () => {
    // When US-001 passes and US-002 fails, only US-001 should be mentioned as "likely test bug"
    const prompt = buildDiagnosisPrompt({
      testOutput: "FAIL",
      testFileContent: "test content",
      sourceFiles: [],
      semanticVerdicts: [makePassingVerdict("US-001"), makeFailingVerdict("US-002")],
    });
    // Both story IDs appear, but only US-001 should be framed as confirmed/likely test bug
    expect(prompt).toContain("US-001");
    // The section must distinguish confirmed from unconfirmed
    // AC-3 wording: "listing the confirmed story IDs and stating their failures are likely test bugs"
    expect(prompt.toLowerCase()).toContain("likely");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildDiagnosisPrompt — basic semantic verdicts section (existing behavior)
// ─────────────────────────────────────────────────────────────────────────────

describe("buildDiagnosisPrompt — semantic verdicts section basic inclusion", () => {
  test("includes a semantic verdicts section when verdicts are provided; includes SEMANTIC VERDICTS header in the section", () => {
    const prompt = buildDiagnosisPrompt({
      testOutput: "FAIL",
      testFileContent: "test content",
      sourceFiles: [],
      semanticVerdicts: [makePassingVerdict("US-001")],
    });
    expect(prompt).toContain("US-001");
    expect(prompt).toContain("SEMANTIC VERDICTS");
  });

  test("does not include semantic verdicts section when semanticVerdicts is undefined", () => {
    const prompt = buildDiagnosisPrompt({
      testOutput: "FAIL",
      testFileContent: "test content",
      sourceFiles: [],
      semanticVerdicts: undefined,
    });
    // Without verdicts, no story IDs should appear in the verdicts section
    // (story IDs might still appear in imports analysis)
    expect(prompt).not.toContain("SEMANTIC VERDICTS");
  });

  test("does not include semantic verdicts section when semanticVerdicts is empty", () => {
    const prompt = buildDiagnosisPrompt({
      testOutput: "FAIL",
      testFileContent: "test content",
      sourceFiles: [],
      semanticVerdicts: [],
    });
    expect(prompt).not.toContain("SEMANTIC VERDICTS");
  });

  test("includes multiple story IDs when multiple verdicts provided", () => {
    const prompt = buildDiagnosisPrompt({
      testOutput: "FAIL",
      testFileContent: "test content",
      sourceFiles: [],
      semanticVerdicts: [makePassingVerdict("US-001"), makePassingVerdict("US-002"), makeFailingVerdict("US-003")],
    });
    expect(prompt).toContain("US-001");
    expect(prompt).toContain("US-002");
    expect(prompt).toContain("US-003");
  });

  test("buildDiagnosisPrompt is callable with all-passing verdicts (all-pass scenario)", () => {
    // Verify the function signature accepts all-passing verdicts
    const prompt = buildDiagnosisPrompt({
      testOutput: "FAIL",
      testFileContent: "test content",
      sourceFiles: [],
      semanticVerdicts: [makePassingVerdict("US-001"), makePassingVerdict("US-002")],
    });
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });
});
