/**
 * Test Output Parser
 *
 * Parses Bun test output (stdout/stderr) into structured failure objects
 * for rectification loop feedback.
 */

/** Structured test failure information */
export interface TestFailure {
  /** File path where the test failed */
  file: string;
  /** Full test name (including nested describe blocks) */
  testName: string;
  /** Error message */
  error: string;
  /** Stack trace lines (truncated to first 5 lines) */
  stackTrace: string[];
}

/** Test run summary */
export interface TestSummary {
  /** Number of tests that passed */
  passed: number;
  /** Number of tests that failed */
  failed: number;
  /** Structured failure details */
  failures: TestFailure[];
}

/**
 * Parse Bun test output into structured failure objects
 *
 * Example output format:
 * ```
 * bun test v1.0.0
 *
 * test/example.test.ts:
 * ✓ passing test [0.5ms]
 * ✗ failing test [1.2ms]
 *
 * (fail) describe block > nested block > test name [1.2ms]
 * Error: Expected 1 to equal 2
 *   at /path/to/file.ts:10:15
 *   at Object.test (/path/to/file.ts:8:3)
 * ```
 */
export function parseBunTestOutput(output: string): TestSummary {
  const lines = output.split("\n");
  const failures: TestFailure[] = [];
  let passed = 0;
  let failed = 0;
  let currentFile = "";
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Extract file path from headers like "test/example.test.ts:"
    if (line.trim().endsWith(".test.ts:") || line.trim().endsWith(".test.js:")) {
      currentFile = line.trim().replace(/:$/, "");
      i++;
      continue;
    }

    // Count passed tests (✓ or ✔)
    if (line.includes("✓") || line.includes("✔")) {
      passed++;
      i++;
      continue;
    }

    // Count failed tests (✗ or ✘)
    if (line.includes("✗") || line.includes("✘")) {
      failed++;
      i++;
      continue;
    }

    // Parse failure line: "(fail) TestName > nested > name [duration]"
    const failMatch = line.match(/^\(fail\)\s+(.+?)\s+\[[\d.]+m?s\]/);
    if (failMatch) {
      const testName = failMatch[1].trim();
      i++;

      // Extract error message and stack trace
      let error = "";
      const stackTrace: string[] = [];
      let stackLineCount = 0;

      // Read lines until we hit a blank line or another test result
      while (i < lines.length && stackLineCount < 5) {
        const nextLine = lines[i];

        // Stop at blank line or next test result
        if (!nextLine.trim() || nextLine.includes("(fail)") || nextLine.includes("✓") || nextLine.includes("✗")) {
          break;
        }

        // First non-blank line is typically the error message
        if (!error && nextLine.trim()) {
          error = nextLine.trim();
          i++;
          continue;
        }

        // Subsequent lines starting with "at" are stack trace
        if (nextLine.trim().startsWith("at ")) {
          stackTrace.push(nextLine.trim());
          stackLineCount++;
        }
        i++;
      }

      failures.push({
        file: currentFile || "unknown",
        testName,
        error: error || "Unknown error",
        stackTrace,
      });
      continue;
    }

    i++;
  }

  return { passed, failed, failures };
}

/**
 * Format failure summary for agent feedback
 *
 * Format:
 * ```
 * 1. file.test.ts > TestName > nested
 *    Error: message
 *    at file.ts:10:15
 *
 * 2. another.test.ts > OtherTest
 *    Error: another error
 *    at other.ts:20:10
 * ```
 *
 * @param failures - Array of test failures
 * @param maxChars - Maximum characters in output (default: 2000)
 * @returns Formatted failure summary string
 */
export function formatFailureSummary(failures: TestFailure[], maxChars = 2000): string {
  if (failures.length === 0) {
    return "No test failures";
  }

  const lines: string[] = [];
  let totalChars = 0;

  for (let i = 0; i < failures.length; i++) {
    const failure = failures[i];
    const num = i + 1;

    // Format: "1. file.test.ts > TestName"
    const header = `${num}. ${failure.file} > ${failure.testName}`;
    const errorLine = `   Error: ${failure.error}`;

    // Add first stack trace line if available
    const stackLine = failure.stackTrace.length > 0 ? `   ${failure.stackTrace[0]}` : "";

    const blockLines = [header, errorLine];
    if (stackLine) {
      blockLines.push(stackLine);
    }
    blockLines.push(""); // blank line separator

    const block = blockLines.join("\n");
    const blockLength = block.length;

    // Check if adding this block would exceed maxChars
    if (totalChars + blockLength > maxChars && lines.length > 0) {
      const remaining = failures.length - i;
      lines.push(`\n... and ${remaining} more failure(s) (truncated)`);
      break;
    }

    lines.push(...blockLines);
    totalChars += blockLength;
  }

  return lines.join("\n").trim();
}
