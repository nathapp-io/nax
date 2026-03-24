/**
 * Test Output Parsing
 *
 * Unified test output parsing logic for Bun test framework.
 * Extracted from execution/test-output-parser.ts and execution/verification.ts.
 */

import type { TestFailure, TestOutputAnalysis, TestSummary } from "./types";

/**
 * Parse Bun test output into structured failure objects.
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
  // Detect Jest/Vitest output by the presence of their summary line format.
  // Jest:   "Tests:       41 failed, 38 passed, 79 total"
  // Vitest: "Test Files  1 failed | 2 passed (3)"
  if (isJestLikeOutput(output)) {
    return parseJestOutput(output);
  }
  return parseBunOutput(output);
}

/**
 * Detect whether the output comes from Jest or Vitest rather than Bun.
 * Looks for the Jest summary line format or Vitest's "Test Files" line.
 */
function isJestLikeOutput(output: string): boolean {
  return /^\s*Tests:\s+\d+/m.test(output) || /^\s*Test Files\s+\d+/m.test(output);
}

/**
 * Parse Jest / Vitest test output into a TestSummary.
 *
 * Jest summary line examples:
 *   "Tests:       41 failed, 38 passed, 79 total"
 *   "Tests:       38 passed, 38 total"
 *
 * Jest failure block example:
 *   "  ● describe block > test name"
 *   "    Expected: ..."
 */
function parseJestOutput(output: string): TestSummary {
  const failures: TestFailure[] = [];
  let passed = 0;
  let failed = 0;

  // Extract counts from the "Tests:" summary line (use the last occurrence)
  const summaryMatches = Array.from(output.matchAll(/^\s*Tests:\s+(.*)/gm));
  if (summaryMatches.length > 0) {
    const summaryLine = summaryMatches[summaryMatches.length - 1][1];

    const failedMatch = summaryLine.match(/(\d+)\s+failed/);
    const passedMatch = summaryLine.match(/(\d+)\s+passed/);
    if (failedMatch) failed = Number.parseInt(failedMatch[1], 10);
    if (passedMatch) passed = Number.parseInt(passedMatch[1], 10);
  }

  // Extract failure test names from "  ● describe > test name" lines
  // Jest marks failures with a bullet "●" character
  let currentFile = "unknown";
  const lines = output.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track FAIL/PASS file headers: "FAIL hooks/usePositionSizer.spec.ts"
    const fileMatch = line.match(/^\s*(?:FAIL|PASS)\s+(\S+\.[jt]sx?)/);
    if (fileMatch) {
      currentFile = fileMatch[1];
      continue;
    }

    // Jest failure marker: "  ● test suite name > test name"
    const bulletMatch = line.match(/^\s+●\s+(.+)$/);
    if (bulletMatch) {
      const testName = bulletMatch[1].trim();
      // Skip bullet-summary headers that end with a block title (no ">" separator)
      // and collect the error from the next non-blank line
      let error = "";
      for (let j = i + 1; j < lines.length && j < i + 10; j++) {
        const next = lines[j].trim();
        if (!next) continue;
        // Stop at next bullet or PASS/FAIL header
        if (next.startsWith("●") || /^(?:FAIL|PASS)\s/.test(next)) break;
        error = next;
        break;
      }
      failures.push({
        file: currentFile,
        testName,
        error: error || "Unknown error",
        stackTrace: [],
      });
    }
  }

  return { passed, failed, failures };
}

/**
 * Original Bun test output parser (unchanged logic).
 */
function parseBunOutput(output: string): TestSummary {
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
 * Format failure summary for agent feedback.
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

/**
 * Parse test output to detect environmental failures.
 *
 * When exit code != 0 but all tests pass, classifies as ENVIRONMENTAL_FAILURE
 * instead of TEST_FAILURE.
 */
export function parseTestOutput(output: string, exitCode: number): TestOutputAnalysis {
  // Regex patterns for different test frameworks
  const patterns = [
    /(\d+)\s+pass(?:ed)?(?:,\s+|\s+)(\d+)\s+fail/i, // "5 pass, 0 fail" or "5 passed 0 fail"
    /Tests:\s+(\d+)\s+passed,\s+(\d+)\s+failed/i, // Jest format
    /(\d+)\s+pass/i, // Bun format (just pass count)
  ];

  let passCount = 0;
  let failCount = 0;

  for (const pattern of patterns) {
    // Match ALL occurrences — use the LAST one (final summary line)
    const matches = Array.from(output.matchAll(new RegExp(pattern, "gi")));
    if (matches.length > 0) {
      const lastMatch = matches[matches.length - 1];
      passCount = Number.parseInt(lastMatch[1], 10);
      // Some formats only show pass count
      failCount = lastMatch[2] ? Number.parseInt(lastMatch[2], 10) : 0;
      break;
    }
  }

  // Check for explicit fail count if not found
  if (failCount === 0) {
    const failMatches = Array.from(output.matchAll(/(\d+)\s+fail/gi));
    if (failMatches.length > 0) {
      failCount = Number.parseInt(failMatches[failMatches.length - 1][1], 10);
    }
  }

  const allTestsPassed = passCount > 0 && failCount === 0;
  const isEnvironmentalFailure = allTestsPassed && exitCode !== 0;

  const result: TestOutputAnalysis = {
    allTestsPassed,
    passCount,
    failCount,
    isEnvironmentalFailure,
  };

  if (isEnvironmentalFailure) {
    result.error = `ENVIRONMENTAL_FAILURE: All ${passCount} tests passed but exit code was ${exitCode}. Check linter/typecheck/missing files.`;
  }

  return result;
}

// Re-export types for consumers that import from this module
export type { TestFailure, TestSummary } from "./types";
