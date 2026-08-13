import { describe, expect, test } from "bun:test";
import { type TestFailure, formatFailureSummary, parseTestOutput } from "../../../src/test-runners";

describe("parseTestOutput", () => {
  test("parses passing output (0 failures)", () => {
    const output = `
bun test v1.0.0

test/example.test.ts:
✓ test 1 [0.5ms]
✓ test 2 [0.3ms]
✓ test 3 [0.7ms]

3 tests passed [1.5ms]
    `.trim();

    const result = parseTestOutput(output);

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

    const result = parseTestOutput(output);

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

    const result = parseTestOutput(output);

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

    const result = parseTestOutput(output);

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].stackTrace).toHaveLength(5);
    expect(result.failures[0].stackTrace[0]).toBe("at line1 (/path/to/file.ts:1:1)");
    expect(result.failures[0].stackTrace[4]).toBe("at line5 (/path/to/file.ts:5:5)");
  });

  test("handles empty/malformed input", () => {
    const emptyResult = parseTestOutput("");
    expect(emptyResult.passed).toBe(0);
    expect(emptyResult.failed).toBe(0);
    expect(emptyResult.failures).toHaveLength(0);

    const malformedResult = parseTestOutput("random text\nno test output");
    expect(malformedResult.passed).toBe(0);
    expect(malformedResult.failed).toBe(0);
    expect(malformedResult.failures).toHaveLength(0);
  });

  // BUG-059: Truncated output from crash/OOM should return passed:0, failed:0
  // so callers can detect inconclusive results
  test.each([
    ["truncated crash", "bun test v1.3.9\n\ntest/unit/agents/claude.test.ts:"],
    ["segfault", "Segmentation fault (core dumped)"],
  ] as const)("returns passed:0, failed:0 for %s output (BUG-059)", (_label, output) => {
    const result = parseTestOutput(output);
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

    const result = parseTestOutput(oomOutput);
    // Some tests passed before crash, but output is incomplete
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(0);
    // Key: callers should check passed > 0 to distinguish from total crash
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

    const result = parseTestOutput(output);

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

    const result = parseTestOutput(output);

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].file).toBe("test/example.test.js");
  });

  test("handles failures without file context; failures with no error message", () => {
    const noFile = parseTestOutput(`bun test v1.0.0\n\n✗ orphan test [1.0ms]\n\n(fail) orphan test [1.0ms]\nError: No file context\n  at /path/to/unknown.ts:1:1\n\n0 passed, 1 failed [1.0ms]`);
    expect(noFile.failures).toHaveLength(1);
    expect(noFile.failures[0].file).toBe("unknown");

    const noMsg = parseTestOutput(`bun test v1.0.0\n\ntest/minimal.test.ts:\n✗ minimal fail [0.5ms]\n\n(fail) minimal fail [0.5ms]\n\n0 passed, 1 failed [0.5ms]`);
    expect(noMsg.failures).toHaveLength(1);
    expect(noMsg.failures[0].error).toBe("Unknown error");
    expect(noMsg.failures[0].stackTrace).toHaveLength(0);
  });

  describe("Jest output — Console pseudo-failure filtering", () => {

    test("does not capture '● Console' when mixed with real failures or in single/multiple files", () => {
      const mixed = parseTestOutput(`FAIL src/commands/kb-import.spec.ts\n  ● Console\n\n    console.error\n      error during test\n\n  ● kb import > AC1 › exits 0 and prints success\n\n    Error: expected 0, got 1\n\nTests:       0 passed, 1 failed, 1 total`);
      expect(mixed.failures).toHaveLength(1);
      expect(mixed.failures[0].testName).toBe("kb import > AC1 › exits 0 and prints success");

      const single = parseTestOutput(`FAIL src/commands/comment.spec.ts\n  ● Console\n\n    console.error\n      Some error logged during a test\n\nTests:       1 passed, 0 failed, 1 total`);
      expect(single.failures).toHaveLength(0);
      expect(single.passed).toBe(1);
      expect(single.failed).toBe(0);

      const multi = parseTestOutput(`FAIL src/commands/comment.spec.ts\n  ● Console\n\n    console.error\n\nFAIL src/commands/label.spec.ts\n  ● Console\n\n    console.log\n\nTests:       0 passed, 0 failed, 2 total`);
      expect(multi.failures).toHaveLength(0);
    });
  });

  describe("Vitest output — no-colon summary line", () => {
    test("parses Vitest's real all-passing summary (no colon after 'Tests')", () => {
      // Reproduces real `vitest run` output — verified against actual CLI output,
      // not Jest's colon-suffixed format that a shared parser previously assumed.
      const output = ` RUN  v4.1.9 /repo/apps/web\n\n\n Test Files  1 passed (1)\n      Tests  5 passed (5)\n   Start at  12:37:53\n   Duration  194ms`;

      const result = parseTestOutput(output);

      expect(result.passed).toBe(5);
      expect(result.failed).toBe(0);
    });

    test("parses Vitest's mixed pass/fail summary (no colon)", () => {
      const output = ` Test Files  1 failed | 1 passed (2)\n      Tests  2 failed | 3 passed (5)`;

      const result = parseTestOutput(output);

      expect(result.passed).toBe(3);
      expect(result.failed).toBe(2);
    });

    test("parses Vitest's zero-test summary as a genuine zero, not a parse miss", () => {
      const output = ` Test Files  1 passed (1)\n      Tests  0 passed (0)`;

      const result = parseTestOutput(output);

      expect(result.passed).toBe(0);
      expect(result.failed).toBe(0);
    });
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

    const result = parseTestOutput(output);

    expect(result.passed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.failures).toHaveLength(1);
  });

  // BUG-060 (issue #989): (fail) lines in batch output must increment `failed`
  test("counts (fail) lines with or without summary; summary backstop dominates", () => {
    // Sub-scenario 1: (fail) lines with summary — summary wins
    const withSummary = parseTestOutput(`test/example.test.ts:\n(fail) suite > test name [10.00ms]\n(fail) suite > test name 2 [2.00ms]\n\n 38 pass\n 23 fail\nRan 61 tests across 3 files.`);
    expect(withSummary.failed).toBe(23);
    expect(withSummary.passed).toBe(38);
    expect(withSummary.failures).toHaveLength(2);

    // Sub-scenario 2: (fail) lines without summary
    const noSummary = parseTestOutput(`test/unit/cli/plan.test.ts:\n(fail) plan > AC-1 [3.00ms]\nError: Expected true\n  at test.ts:12:5\n(fail) plan > AC-2 [2.00ms]\nError: Expected false\n  at test.ts:22:5`);
    expect(noSummary.failed).toBe(2);
    expect(noSummary.passed).toBe(0);
    expect(noSummary.failures).toHaveLength(2);
  });

  // BUG-060: summary line counts dominate per-line glyph counts
  test("uses bun summary line counts as backstop when summary exceeds per-line counts", () => {
    const output = `
test/unit/cli/plan.test.ts:
(fail) plan > US-001 > something [5.00ms]

 9 pass
 9 fail
Ran 18 tests across 1 file.`.trim();

    const result = parseTestOutput(output);

    // summary says 9 fail — must win over the 0 counted from missing glyphs
    expect(result.failed).toBe(9);
    expect(result.passed).toBe(9);
    expect(result.failures).toHaveLength(1);
  });

  // BUG-060: verbose mode must not double-count — ✗ glyph + (fail) block for same test
  test("does not double-count failures in verbose mode (glyph and (fail) block for same test)", () => {
    const output = `
test/unit/cli/plan.test.ts:
✓ passing test [0.5ms]
✗ failing test 1 [1.2ms]
✗ failing test 2 [0.8ms]

(fail) failing test 1 [1.2ms]
Error: Expected true
  at test.ts:10:5
(fail) failing test 2 [0.8ms]
Error: Expected false
  at test.ts:20:5

2 pass
2 fail`.trim();

    const result = parseTestOutput(output);

    // 2 failures, not 4 (must not count ✗ glyph AND (fail) block separately)
    expect(result.failed).toBe(2);
    expect(result.passed).toBe(2);
    expect(result.failures).toHaveLength(2);
  });
});

describe("formatFailureSummary", () => {
  test("returns 'No test failures' for empty array; formats single failure correctly", () => {
    expect(formatFailureSummary([])).toBe("No test failures");

    const result = formatFailureSummary([{ file: "test/example.test.ts", testName: "failing test", error: "Expected 1 to equal 2", stackTrace: ["at /path/to/file.ts:10:15"] }]);
    expect(result).toContain("1. test/example.test.ts > failing test");
    expect(result).toContain("Error: Expected 1 to equal 2");
    expect(result).toContain("at /path/to/file.ts:10:15");
  });

  test("formats multiple failures with numbering and blank line separation", () => {
    const failures: TestFailure[] = [
      { file: "test/file1.test.ts", testName: "test 1", error: "Error 1", stackTrace: ["at /path/file1.ts:5:10"] },
      { file: "test/file2.test.ts", testName: "test 2", error: "Error 2", stackTrace: ["at /path/file2.ts:15:20"] },
    ];
    const result = formatFailureSummary(failures);
    expect(result).toContain("1. test/file1.test.ts > test 1");
    expect(result).toContain("Error: Error 1");
    expect(result).toContain("2. test/file2.test.ts > test 2");
    expect(result).toContain("Error: Error 2");
    expect(result.split("\n").filter((l) => l.trim() === "").length).toBeGreaterThan(0);
  });

  test("truncates at explicit maxChars and at default 2000", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      file: `test/file${i}.test.ts`,
      testName: `test ${i}`,
      error: `Error message ${i}`,
      stackTrace: [`at /path/file${i}.ts:${i}:${i}`],
    }));
    const small = formatFailureSummary(many.slice(0, 10), 300);
    expect(small.length).toBeLessThanOrEqual(350);
    expect(small).toContain("... and");
    expect(small).toContain("more failure(s) (truncated)");
    const full = formatFailureSummary(many);
    expect(full.length).toBeLessThanOrEqual(2100);
    expect(full).toContain("(truncated)");
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

  test("handles failure without stack trace and includes only first of multiple stack lines", () => {
    const noStack: TestFailure[] = [{ file: "test/nostack.test.ts", testName: "no stack", error: "Error without stack", stackTrace: [] }];
    const r1 = formatFailureSummary(noStack);
    expect(r1).toContain("1. test/nostack.test.ts > no stack");
    expect(r1).toContain("Error: Error without stack");
    expect(r1).not.toContain("at ");

    const multiStack: TestFailure[] = [{ file: "test/multi.test.ts", testName: "multi stack", error: "Error with multiple stack lines", stackTrace: ["at /path/file.ts:10:5", "at /path/file.ts:20:10", "at /path/file.ts:30:15"] }];
    const r2 = formatFailureSummary(multiStack);
    expect(r2).toContain("at /path/file.ts:10:5");
    expect(r2).not.toContain("at /path/file.ts:20:10");
    expect(r2).not.toContain("at /path/file.ts:30:15");
  });

});
