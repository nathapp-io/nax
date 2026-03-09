import { describe, expect, test } from "bun:test";
import { type TestFailure, formatFailureSummary, parseBunTestOutput } from "../../src/execution/test-output-parser";

describe("parseBunTestOutput", () => {
  test("parses passing output (0 failures)", () => {
    const output = `
bun test v1.0.0

test/example.test.ts:
✓ test 1 [0.5ms]
✓ test 2 [0.3ms]
✓ test 3 [0.7ms]

3 tests passed [1.5ms]
    `.trim();

    const result = parseBunTestOutput(output);

    expect(result.passed).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.failures).toHaveLength(0);
  });

  test("parses mixed pass/fail output", () => {
    const output = `
bun test v1.0.0

test/example.test.ts:
✓ passing test [0.5ms]
✗ failing test [1.2ms]

(fail) failing test [1.2ms]
Error: Expected 1 to equal 2
  at /path/to/file.ts:10:15
  at Object.test (/path/to/file.ts:8:3)

1 passed, 1 failed [1.7ms]
    `.trim();

    const result = parseBunTestOutput(output);

    expect(result.passed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].file).toBe("test/example.test.ts");
    expect(result.failures[0].testName).toBe("failing test");
    expect(result.failures[0].error).toBe("Error: Expected 1 to equal 2");
    expect(result.failures[0].stackTrace).toHaveLength(2);
  });

  test("extracts test names from nested describe blocks", () => {
    const output = `
bun test v1.0.0

test/nested.test.ts:
✓ outer test [0.2ms]
✗ inner test [0.8ms]

(fail) describe block > nested block > inner test [0.8ms]
Error: Assertion failed
  at /path/to/nested.ts:20:10

1 passed, 1 failed [1.0ms]
    `.trim();

    const result = parseBunTestOutput(output);

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].testName).toBe("describe block > nested block > inner test");
    expect(result.failures[0].file).toBe("test/nested.test.ts");
  });

  test("truncates stack trace to 5 lines", () => {
    const output = `
bun test v1.0.0

test/stack.test.ts:
✗ test with long stack [2.0ms]

(fail) test with long stack [2.0ms]
Error: Stack overflow
  at line1 (/path/to/file.ts:1:1)
  at line2 (/path/to/file.ts:2:2)
  at line3 (/path/to/file.ts:3:3)
  at line4 (/path/to/file.ts:4:4)
  at line5 (/path/to/file.ts:5:5)
  at line6 (/path/to/file.ts:6:6)
  at line7 (/path/to/file.ts:7:7)
  at line8 (/path/to/file.ts:8:8)

0 passed, 1 failed [2.0ms]
    `.trim();

    const result = parseBunTestOutput(output);

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].stackTrace).toHaveLength(5);
    expect(result.failures[0].stackTrace[0]).toBe("at line1 (/path/to/file.ts:1:1)");
    expect(result.failures[0].stackTrace[4]).toBe("at line5 (/path/to/file.ts:5:5)");
  });

  test("handles empty/malformed input", () => {
    const emptyResult = parseBunTestOutput("");
    expect(emptyResult.passed).toBe(0);
    expect(emptyResult.failed).toBe(0);
    expect(emptyResult.failures).toHaveLength(0);

    const malformedResult = parseBunTestOutput("random text\nno test output");
    expect(malformedResult.passed).toBe(0);
    expect(malformedResult.failed).toBe(0);
    expect(malformedResult.failures).toHaveLength(0);
  });

  // BUG-059: Truncated output from crash/OOM should return passed:0, failed:0
  // so callers can detect inconclusive results
  test("returns passed:0, failed:0 for truncated crash output (BUG-059)", () => {
    // Bun crashed mid-run — only header and partial file output, no test results
    const crashOutput = `
bun test v1.3.9

test/unit/agents/claude.test.ts:
`.trim();

    const result = parseBunTestOutput(crashOutput);
    expect(result.passed).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.failures).toHaveLength(0);
  });

  test("returns passed:0, failed:0 for OOM killed output (BUG-059)", () => {
    // Bun was OOM-killed — output ends abruptly with error message
    const oomOutput = `
bun test v1.3.9

test/unit/config/schema.test.ts:
✓ validates required fields [0.5ms]
✓ rejects invalid model tiers [0.3ms]

test/unit/agents/claude.test.ts:
Killed
`.trim();

    const result = parseBunTestOutput(oomOutput);
    // Some tests passed before crash, but output is incomplete
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(0);
    // Key: callers should check passed > 0 to distinguish from total crash
  });

  test("returns passed:0, failed:0 for segfault output (BUG-059)", () => {
    const segfaultOutput = "Segmentation fault (core dumped)";

    const result = parseBunTestOutput(segfaultOutput);
    expect(result.passed).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.failures).toHaveLength(0);
  });

  test("handles multiple test files", () => {
    const output = `
bun test v1.0.0

test/file1.test.ts:
✓ test 1 [0.5ms]
✗ test 2 [1.2ms]

(fail) test 2 [1.2ms]
Error: File 1 error
  at /path/to/file1.ts:10:15

test/file2.test.ts:
✓ test 3 [0.3ms]
✗ test 4 [0.8ms]

(fail) test 4 [0.8ms]
Error: File 2 error
  at /path/to/file2.ts:20:25

2 passed, 2 failed [2.8ms]
    `.trim();

    const result = parseBunTestOutput(output);

    expect(result.passed).toBe(2);
    expect(result.failed).toBe(2);
    expect(result.failures).toHaveLength(2);
    expect(result.failures[0].file).toBe("test/file1.test.ts");
    expect(result.failures[0].error).toBe("Error: File 1 error");
    expect(result.failures[1].file).toBe("test/file2.test.ts");
    expect(result.failures[1].error).toBe("Error: File 2 error");
  });

  test("handles test files with .js extension", () => {
    const output = `
bun test v1.0.0

test/example.test.js:
✗ failing test [1.0ms]

(fail) failing test [1.0ms]
Error: JS test error
  at /path/to/file.js:5:10

0 passed, 1 failed [1.0ms]
    `.trim();

    const result = parseBunTestOutput(output);

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].file).toBe("test/example.test.js");
  });

  test("handles failures without file context", () => {
    const output = `
bun test v1.0.0

✗ orphan test [1.0ms]

(fail) orphan test [1.0ms]
Error: No file context
  at /path/to/unknown.ts:1:1

0 passed, 1 failed [1.0ms]
    `.trim();

    const result = parseBunTestOutput(output);

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].file).toBe("unknown");
  });

  test("handles failures with no error message", () => {
    const output = `
bun test v1.0.0

test/minimal.test.ts:
✗ minimal fail [0.5ms]

(fail) minimal fail [0.5ms]

0 passed, 1 failed [0.5ms]
    `.trim();

    const result = parseBunTestOutput(output);

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].error).toBe("Unknown error");
    expect(result.failures[0].stackTrace).toHaveLength(0);
  });

  test("handles alternative check marks (✔ and ✘)", () => {
    const output = `
bun test v1.0.0

test/marks.test.ts:
✔ pass with heavy check [0.2ms]
✘ fail with heavy X [0.5ms]

(fail) fail with heavy X [0.5ms]
Error: Alternative marks error

1 passed, 1 failed [0.7ms]
    `.trim();

    const result = parseBunTestOutput(output);

    expect(result.passed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.failures).toHaveLength(1);
  });
});

describe("formatFailureSummary", () => {
  test("returns 'No test failures' for empty array", () => {
    const result = formatFailureSummary([]);
    expect(result).toBe("No test failures");
  });

  test("formats single failure", () => {
    const failures: TestFailure[] = [
      {
        file: "test/example.test.ts",
        testName: "failing test",
        error: "Expected 1 to equal 2",
        stackTrace: ["at /path/to/file.ts:10:15"],
      },
    ];

    const result = formatFailureSummary(failures);

    expect(result).toContain("1. test/example.test.ts > failing test");
    expect(result).toContain("Error: Expected 1 to equal 2");
    expect(result).toContain("at /path/to/file.ts:10:15");
  });

  test("formats multiple failures", () => {
    const failures: TestFailure[] = [
      {
        file: "test/file1.test.ts",
        testName: "test 1",
        error: "Error 1",
        stackTrace: ["at /path/file1.ts:5:10"],
      },
      {
        file: "test/file2.test.ts",
        testName: "test 2",
        error: "Error 2",
        stackTrace: ["at /path/file2.ts:15:20"],
      },
    ];

    const result = formatFailureSummary(failures);

    expect(result).toContain("1. test/file1.test.ts > test 1");
    expect(result).toContain("Error: Error 1");
    expect(result).toContain("2. test/file2.test.ts > test 2");
    expect(result).toContain("Error: Error 2");
  });

  test("respects maxChars limit", () => {
    const failures: TestFailure[] = Array.from({ length: 10 }, (_, i) => ({
      file: `test/file${i}.test.ts`,
      testName: `test ${i}`,
      error: `Error message ${i}`,
      stackTrace: [`at /path/file${i}.ts:${i}:${i}`],
    }));

    const result = formatFailureSummary(failures, 300);

    expect(result.length).toBeLessThanOrEqual(350); // Some buffer for truncation message
    expect(result).toContain("... and");
    expect(result).toContain("more failure(s) (truncated)");
  });

  test("handles failure without stack trace", () => {
    const failures: TestFailure[] = [
      {
        file: "test/nostack.test.ts",
        testName: "no stack",
        error: "Error without stack",
        stackTrace: [],
      },
    ];

    const result = formatFailureSummary(failures);

    expect(result).toContain("1. test/nostack.test.ts > no stack");
    expect(result).toContain("Error: Error without stack");
    expect(result).not.toContain("at ");
  });

  test("handles nested test names", () => {
    const failures: TestFailure[] = [
      {
        file: "test/nested.test.ts",
        testName: "outer > middle > inner",
        error: "Nested test error",
        stackTrace: ["at /path/nested.ts:30:5"],
      },
    ];

    const result = formatFailureSummary(failures);

    expect(result).toContain("1. test/nested.test.ts > outer > middle > inner");
    expect(result).toContain("Error: Nested test error");
  });

  test("includes only first stack trace line", () => {
    const failures: TestFailure[] = [
      {
        file: "test/multi.test.ts",
        testName: "multi stack",
        error: "Error with multiple stack lines",
        stackTrace: ["at /path/file.ts:10:5", "at /path/file.ts:20:10", "at /path/file.ts:30:15"],
      },
    ];

    const result = formatFailureSummary(failures);

    expect(result).toContain("at /path/file.ts:10:5");
    expect(result).not.toContain("at /path/file.ts:20:10");
    expect(result).not.toContain("at /path/file.ts:30:15");
  });

  test("separates failures with blank lines", () => {
    const failures: TestFailure[] = [
      {
        file: "test/a.test.ts",
        testName: "test a",
        error: "Error A",
        stackTrace: ["at a.ts:1:1"],
      },
      {
        file: "test/b.test.ts",
        testName: "test b",
        error: "Error B",
        stackTrace: ["at b.ts:2:2"],
      },
    ];

    const result = formatFailureSummary(failures);

    // Check that there's proper separation between failures
    const lines = result.split("\n");
    const blankLines = lines.filter((line) => line.trim() === "");
    expect(blankLines.length).toBeGreaterThan(0);
  });

  test("uses default maxChars of 2000", () => {
    const failures: TestFailure[] = Array.from({ length: 50 }, (_, i) => ({
      file: `test/file${i}.test.ts`,
      testName: `test ${i}`,
      error: `Error message ${i}`,
      stackTrace: [`at /path/file${i}.ts:${i}:${i}`],
    }));

    const result = formatFailureSummary(failures); // No maxChars argument

    expect(result.length).toBeLessThanOrEqual(2100); // Some buffer
    expect(result).toContain("(truncated)");
  });
});
