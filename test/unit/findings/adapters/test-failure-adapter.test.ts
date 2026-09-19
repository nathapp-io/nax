/**
 * testFailureToFinding — the seam where a parsed TestFailure becomes the
 * Finding whose `message` is rendered as `Error: …` in the rectifier prompt
 * (src/prompts/builders/rectifier-builder-helpers.ts formatFailingTestsList).
 *
 * Every sub-parser collects stackTrace; this adapter used to drop it, so the
 * rectifying agent got a message with no location.
 */
import { describe, expect, test } from "bun:test";
import { testFailureToFinding, testSummaryToFindings } from "@/findings";
import type { TestFailure } from "@/test-runners";

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
  test("keeps the parsed message as the leading line", () => {
    const f = testFailureToFinding(BASE);
    expect(f.message.split("\n")[0]).toBe(BASE.error);
  });

  test("appends the first two stack frames so the agent gets a location", () => {
    const f = testFailureToFinding(BASE);
    expect(f.message).toContain("at <anonymous> (test/unit/tools/policy.test.ts:84:20)");
    expect(f.message).toContain("at run (bun:test:1:1)");
  });

  test("caps the appended frames at two", () => {
    const f = testFailureToFinding(BASE);
    expect(f.message).not.toContain("at third (bun:test:2:2)");
  });

  test("a failure with no stack frames yields the message alone, with no trailing blank", () => {
    const f = testFailureToFinding({ ...BASE, stackTrace: [] });
    expect(f.message).toBe(BASE.error);
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
