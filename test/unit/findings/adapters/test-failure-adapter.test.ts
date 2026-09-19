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

  test("puts each frame on its own line so the contract is `error\\nframe1\\nframe2`", () => {
    // Earlier "leading line" assertion would also pass if a future change put
    // frames on the same line as the error (`error | frame1 | frame2`),
    // making the wire shape drift invisible. Pin the shape explicitly.
    const f = testFailureToFinding(BASE);
    expect(f.message).toBe(
      [BASE.error, "at <anonymous> (test/unit/tools/policy.test.ts:84:20)", "at run (bun:test:1:1)"].join("\n"),
    );
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
