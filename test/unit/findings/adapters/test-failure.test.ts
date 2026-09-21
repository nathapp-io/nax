import { describe, expect, test } from "bun:test";
import { testFailureToFinding, testSummaryToFindings } from "@/findings";
import type { TestFailure, TestSummary } from "@/test-runners";

/**
 * testFailureToFinding — the seam where a parsed TestFailure becomes the
 * Finding whose `message` is rendered as `Error: …` in the rectifier prompt
 * (src/prompts/builders/rectifier-builder-helpers.ts formatFailingTestsList).
 *
 * Every sub-parser collects stackTrace; this adapter used to drop it, so the
 * rectifying agent got a message with no location.
 */
const BASE: TestFailure = {
  file: "test/unit/tools/policy.test.ts",
  testName: "policy > confines a path",
  error: "expect(received).toEqual(expected) Expected: 4 Received: 3",
  stackTrace: [
    "at <anonymous> (test/unit/tools/policy.test.ts:84:20)",
    "at run (bun:test:1:1)",
    "at third (bun:test:2:2)",
  ],
};

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

  test("keeps the parsed message as the leading line; puts each frame on its own line so the contract is `error\\\\nframe1\\\\nframe2`; caps the appended frames at two", () => {
    const f = testFailureToFinding(BASE);
    expect(f.message.split("\n")[0]).toBe(BASE.error);
    expect(f.message).toBe(
      [BASE.error, "at <anonymous> (test/unit/tools/policy.test.ts:84:20)", "at run (bun:test:1:1)"].join("\n"),
    );
    expect(f.message).not.toContain("at third (bun:test:2:2)");
  });

  test("appends the first two stack frames so the agent gets a location", () => {
    const f = testFailureToFinding(BASE);
    expect(f.message).toContain("at <anonymous> (test/unit/tools/policy.test.ts:84:20)");
    expect(f.message).toContain("at run (bun:test:1:1)");
  });

  test("a failure with no stack frames yields the message alone, with no trailing blank", () => {
    const f = testFailureToFinding({ ...BASE, stackTrace: [] });
    expect(f.message).toBe(BASE.error);
    // No stray newline at the tail: formatFailingTestsList would emit a
    // dangling line and the indented-frames test would then leak that empty
    // line into its filter.
    expect(f.message.endsWith("\n")).toBe(false);
  });

  test("a failure with stackTrace left undefined renders the message alone (no crash, no stray newline)", () => {
    // e2e fixtures (#2150) build TestFailure-shaped objects via narrow
    // structurally-typed object literals that omit `stackTrace`. The adapter
    // is a boundary and must defend against that shape — if it dereferenced
    // `failure.stackTrace` directly, the full-suite-rectify path crashes
    // with "stackTrace.slice of undefined". Pin the forgiving behaviour.
    const partial: TestFailure = {
      file: BASE.file,
      testName: BASE.testName,
      error: BASE.error,
    };
    const f = testFailureToFinding(partial);
    expect(f.message).toBe(BASE.error);
    expect(f.message.endsWith("\n")).toBe(false);
  });

  test("file, rule, source, severity and category are unchanged", () => {
    const f = testFailureToFinding(BASE);
    expect(f.file).toBe(BASE.file);
    expect(f.rule).toBe(BASE.testName);
    expect(f.source).toBe("test-runner");
    expect(f.severity).toBe("error");
    expect(f.category).toBe("failed-test");
  });

  test("testSummaryToFindings maps every failure through the same adapter", () => {
    const findings = testSummaryToFindings({ passed: 0, failed: 2, failures: [BASE, { ...BASE, testName: "other" }] });
    expect(findings).toHaveLength(2);
    expect(findings[1].rule).toBe("other");
    expect(findings[1].message).toContain("at <anonymous>");
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
