import { describe, expect, test } from "bun:test";
import { testFailureToFinding, testSummaryToFindings } from "@/findings";
import type { TestFailure, TestSummary } from "@/test-runners";

describe("testFailureToFinding", () => {
  test("maps TestFailure fields to Finding fields", () => {
    const failure: TestFailure = {
      file: "test/unit/foo.test.ts",
      testName: "should handle edge case",
      error: "Expected 1 but got 0",
      stackTrace: [],
    };
    const finding = testFailureToFinding(failure);
    expect(finding.source).toBe("test-runner");
    expect(finding.severity).toBe("error");
    expect(finding.category).toBe("failed-test");
    expect(finding.rule).toBe("should handle edge case");
    expect(finding.file).toBe("test/unit/foo.test.ts");
    expect(finding.message).toBe("Expected 1 but got 0");
    expect(finding.line).toBeUndefined();
  });

  test("sets no line field (TestFailure has no line)", () => {
    const failure: TestFailure = {
      file: "test/unit/bar.test.ts",
      testName: "bar test",
      error: "boom",
      stackTrace: ["at line 5"],
    };
    const finding = testFailureToFinding(failure);
    expect(finding.line).toBeUndefined();
  });
});

describe("testSummaryToFindings", () => {
  test("returns empty array for empty failures", () => {
    const summary: TestSummary = { passed: 5, failed: 0, failures: [] };
    expect(testSummaryToFindings(summary)).toEqual([]);
  });

  test("maps each failure to a Finding", () => {
    const summary: TestSummary = {
      passed: 0,
      failed: 2,
      failures: [
        { file: "a.test.ts", testName: "test A", error: "err A", stackTrace: [] },
        { file: "b.test.ts", testName: "test B", error: "err B", stackTrace: [] },
      ],
    };
    const findings = testSummaryToFindings(summary);
    expect(findings).toHaveLength(2);
    expect(findings[0].rule).toBe("test A");
    expect(findings[1].rule).toBe("test B");
    expect(findings[0].source).toBe("test-runner");
    expect(findings[0].category).toBe("failed-test");
  });
});
