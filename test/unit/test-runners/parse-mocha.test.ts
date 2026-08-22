import { describe, expect, test } from "bun:test";
import { parseMochaOutput } from "@/test-runners";

describe("parseMochaOutput", () => {
  test("extracts counts and structured failure from spec reporter", () => {
    const output = `
  MySuite
    ✓ passes
    1) fails

  1 passing (12ms)
  1 failing

  1) MySuite fails:
     AssertionError: expected 1 to equal 2
      at Context.<anonymous> (test/foo.test.js:8:20)
`.trimEnd();
    const summary = parseMochaOutput(output);
    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0].testName).toBe("MySuite fails");
    expect(summary.failures[0].error).toContain("AssertionError");
    expect(summary.failures[0].file).toBe("test/foo.test.js");
    expect(summary.failures[0].stackTrace).toContain("test/foo.test.js:8");
  });

  test("does not double-count the inline tree failure marker", () => {
    const output = `
  MySuite
    1) fails

  0 passing (5ms)
  1 failing

  1) MySuite fails:
     Error: boom
      at Context.<anonymous> (test/bar.test.js:3:5)
`.trimEnd();
    const summary = parseMochaOutput(output);
    expect(summary.failures).toHaveLength(1);
  });

  test("counts-only run (no failing section) yields no failures", () => {
    const output = "  4 passing (20ms)";
    const summary = parseMochaOutput(output);
    expect(summary.passed).toBe(4);
    expect(summary.failed).toBe(0);
    expect(summary.failures).toEqual([]);
  });

  // BUG-15: an early spec's own "0 passing"/progress line must not win over
  // the true final summary — the LAST "N passing"/"N failing" match wins.
  test("BUG-15: the final summary wins over an earlier per-spec progress line", () => {
    const output = "spec1: 0 passing\nspec2: 5 passing, 1 failing\n\n5 passing\n1 failing\n";
    const summary = parseMochaOutput(output);
    expect(summary.passed).toBe(5);
    expect(summary.failed).toBe(1);
  });
});
