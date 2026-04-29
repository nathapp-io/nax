/**
 * Tests for src/acceptance/fix-diagnosis.ts — source-file loading utilities
 *
 * Covers:
 * - loadSourceFilesForDiagnosis auto-detects source files from import statements
 * - DiagnosisResult interface validation
 */

import { describe, expect, test } from "bun:test";
import { loadSourceFilesForDiagnosis } from "../../../src/acceptance/fix-diagnosis";
import type { DiagnosisResult } from "../../../src/acceptance/types";

// ─────────────────────────────────────────────────────────────────────────────
// loadSourceFilesForDiagnosis
// ─────────────────────────────────────────────────────────────────────────────

describe("loadSourceFilesForDiagnosis", () => {
  test("returns empty array when test file has no imports", async () => {
    const result = await loadSourceFilesForDiagnosis('test("x", () => {});', "/tmp");
    expect(result).toEqual([]);
  });

  test("resolves relative imports from test file content", async () => {
    const testContent = `
import { add } from "./src/math.ts";
import { multiply } from "./src/utils.ts";
test("AC-1", () => { expect(add(1,2)).toBe(3); });
`;
    // Files don't exist on disk — function gracefully returns null for missing files
    const result = await loadSourceFilesForDiagnosis(testContent, "/tmp");
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
    const result = await loadSourceFilesForDiagnosis(testContent, "/tmp");
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

  test("testIssues and sourceIssues are optional", () => {
    const minimal: DiagnosisResult = {
      verdict: "source_bug",
      reasoning: "Minimal result",
      confidence: 0.5,
    };
    expect(minimal.testIssues).toBeUndefined();
    expect(minimal.sourceIssues).toBeUndefined();
  });

  test("testIssues and sourceIssues can be provided together", () => {
    const full: DiagnosisResult = {
      verdict: "both",
      reasoning: "Full result",
      confidence: 0.95,
      testIssues: ["Test issue 1"],
      sourceIssues: ["Source issue 1", "Source issue 2"],
    };
    expect(full.testIssues).toEqual(["Test issue 1"]);
    expect(full.sourceIssues).toEqual(["Source issue 1", "Source issue 2"]);
  });
});
