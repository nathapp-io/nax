/**
 * Test Output Parsing — SSOT
 *
 * Single entry point for parsing test runner output across all supported frameworks.
 * Use `parseTestOutput(output)` — it auto-detects the framework and dispatches.
 *
 * Supported:
 *   - Bun test
 *   - Jest / Vitest
 *   - pytest        (common-parser fallback — structured extraction TODO)
 *   - go test       (common-parser fallback — structured extraction TODO)
 *   - Unknown       (common-parser fallback via broad regexes)
 */

import type { TestFailure, TestOutputAnalysis, TestSummary } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Framework detection
// ─────────────────────────────────────────────────────────────────────────────

type Framework = "bun" | "jest" | "vitest" | "pytest" | "go" | "unknown";

function detectFramework(output: string): Framework {
  // Vitest: "Test Files  1 failed | 2 passed (3)"
  if (/^\s*Test Files\s+\d+/m.test(output)) return "vitest";
  // Jest: "Tests:       41 failed, 38 passed, 79 total"
  if (/^\s*Tests:\s+\d+/m.test(output)) return "jest";
  // pytest: "====== X failed, Y passed in Z.Zs ======"
  if (/={3,}\s+\d+\s+(?:failed|passed).*in\s+[\d.]+s\s*={3,}/m.test(output)) return "pytest";
  // go test: "--- FAIL:" or "ok  \t" or "FAIL\t"
  if (/^--- (?:FAIL|PASS):/m.test(output) || /^(?:ok|FAIL)\s+\t/m.test(output)) return "go";
  // Bun: "(fail)" marker, bun test header, or bun's Unicode checkmarks (✓ ✔ ✗ ✘)
  if (/^\(fail\)\s/m.test(output) || /^bun test/m.test(output) || /[✓✔✗✘]/m.test(output)) return "bun";
  return "unknown";
}

// ─────────────────────────────────────────────────────────────────────────────
// Public SSOT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse test runner output into a structured TestSummary.
 *
 * Auto-detects the framework from output content and dispatches to the
 * appropriate sub-parser. Falls back to a common regex-based parser for
 * unknown or unsupported formats.
 */
export function parseTestOutput(output: string): TestSummary {
  const framework = detectFramework(output);
  switch (framework) {
    case "bun":
      return parseBunOutput(output);
    case "jest":
    case "vitest":
      return parseJestOutput(output);
    case "pytest":
      return parsePytestOutput(output);
    case "go":
      return parseGoTestOutput(output);
    default:
      return parseCommonOutput(output);
  }
}

/**
 * @deprecated Use `parseTestOutput` instead — it auto-detects the framework.
 */
export function parseBunTestOutput(output: string): TestSummary {
  return parseTestOutput(output);
}

// ─────────────────────────────────────────────────────────────────────────────
// Framework-specific parsers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse Bun test output.
 *
 * Example format:
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
 * ```
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

      let error = "";
      const stackTrace: string[] = [];
      let stackLineCount = 0;

      while (i < lines.length && stackLineCount < 5) {
        const nextLine = lines[i];
        if (!nextLine.trim() || nextLine.includes("(fail)") || nextLine.includes("✓") || nextLine.includes("✗")) {
          break;
        }
        if (!error && nextLine.trim()) {
          error = nextLine.trim();
          i++;
          continue;
        }
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
 * Parse Jest / Vitest test output.
 *
 * Jest summary line examples:
 *   "Tests:       41 failed, 38 passed, 79 total"
 *   "Tests:       38 passed, 38 total"
 *
 * Vitest summary line examples:
 *   "Test Files  1 failed | 2 passed (3)"
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
      let error = "";
      for (let j = i + 1; j < lines.length && j < i + 10; j++) {
        const next = lines[j].trim();
        if (!next) continue;
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
 * Parse pytest output.
 *
 * Example format:
 * ```
 * FAILED tests/test_foo.py::test_bar - AssertionError: assert 1 == 2
 * ====== 2 failed, 5 passed in 0.42s ======
 * ```
 *
 * TODO: Add structured error/stack extraction from the verbose block.
 * Currently falls back to common parser for counts and extracts FAILED lines for names.
 */
function parsePytestOutput(output: string): TestSummary {
  const common = parseCommonOutput(output);

  // Structured failure names from "FAILED path::test_name - reason" lines
  const failures: TestFailure[] = [];
  for (const line of output.split("\n")) {
    const m = line.match(/^FAILED\s+(\S+)(?:\s+-\s+(.*))?$/);
    if (m) {
      const [, location, reason] = m;
      const parts = location.split("::");
      failures.push({
        file: parts[0] ?? location,
        testName: parts.slice(1).join(" > ") || location,
        error: reason?.trim() || "Unknown error",
        stackTrace: [],
      });
    }
  }

  return {
    passed: common.passed,
    failed: common.failed,
    failures: failures.length > 0 ? failures : common.failures,
  };
}

/**
 * Parse `go test` output.
 *
 * Example format:
 * ```
 * --- FAIL: TestFoo (0.00s)
 *     foo_test.go:12: Error message
 * ok  	example.com/pkg	0.042s
 * FAIL	example.com/pkg	0.001s
 * ```
 *
 * TODO: Add structured error extraction from indented lines after "--- FAIL:".
 * Currently falls back to common parser for counts and extracts FAIL lines for names.
 */
function parseGoTestOutput(output: string): TestSummary {
  const common = parseCommonOutput(output);

  // Structured failure names from "--- FAIL: TestName (Xs)" lines
  const failures: TestFailure[] = [];
  for (const line of output.split("\n")) {
    const m = line.match(/^--- FAIL:\s+(\S+)\s+\([\d.]+s\)/);
    if (m) {
      failures.push({
        file: "unknown",
        testName: m[1],
        error: "Unknown error",
        stackTrace: [],
      });
    }
  }

  return {
    passed: common.passed,
    failed: common.failed,
    failures: failures.length > 0 ? failures : common.failures,
  };
}

/**
 * Common fallback parser using broad regexes.
 *
 * Handles any output that includes pass/fail count patterns, regardless of framework.
 * Does not extract structured failure details — returns empty failures array.
 *
 * Patterns matched:
 *   "5 passed, 2 failed"  "5 pass, 2 fail"  "Tests: 5 passed"  "2 fail"
 */
function parseCommonOutput(output: string): TestSummary {
  let passed = 0;
  let failed = 0;

  const patterns: RegExp[] = [
    /(\d+)\s+pass(?:ed)?(?:,\s*|\s+)(\d+)\s+fail/i,
    /Tests:\s+(\d+)\s+passed,\s+(\d+)\s+failed/i,
    /(\d+)\s+pass/i,
  ];

  for (const pattern of patterns) {
    const matches = Array.from(output.matchAll(new RegExp(pattern, "gi")));
    if (matches.length > 0) {
      const last = matches[matches.length - 1];
      passed = Number.parseInt(last[1], 10);
      failed = last[2] ? Number.parseInt(last[2], 10) : 0;
      break;
    }
  }

  // Fallback: pick up a bare fail count if not already found
  if (failed === 0) {
    const failMatches = Array.from(output.matchAll(/(\d+)\s+fail/gi));
    if (failMatches.length > 0) {
      failed = Number.parseInt(failMatches[failMatches.length - 1][1], 10);
    }
  }

  return { passed, failed, failures: [] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatting
// ─────────────────────────────────────────────────────────────────────────────

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

    const header = `${num}. ${failure.file} > ${failure.testName}`;
    const errorLine = `   Error: ${failure.error}`;
    const stackLine = failure.stackTrace.length > 0 ? `   ${failure.stackTrace[0]}` : "";

    const blockLines = [header, errorLine];
    if (stackLine) blockLines.push(stackLine);
    blockLines.push("");

    const block = blockLines.join("\n");
    if (totalChars + block.length > maxChars && lines.length > 0) {
      lines.push(`\n... and ${failures.length - i} more failure(s) (truncated)`);
      break;
    }

    lines.push(...blockLines);
    totalChars += block.length;
  }

  return lines.join("\n").trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Exit-code analysis (separate concern from output parsing)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Analyze test output + exit code to detect environmental failures.
 *
 * When exit code != 0 but all tests pass, classifies as ENVIRONMENTAL_FAILURE
 * (e.g. open handles, linter errors, missing files) rather than TEST_FAILURE.
 *
 * This is a separate concern from `parseTestOutput` — it answers
 * "did the runner environment fail?" not "which tests failed?".
 */
export function analyzeTestExitCode(output: string, exitCode: number): TestOutputAnalysis {
  const { passed: passCount, failed: failCount } = parseCommonOutput(output);

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
