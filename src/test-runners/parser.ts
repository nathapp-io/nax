/**
 * Test Output Parser — SSOT
 *
 * Single entry point for parsing test runner output across all supported frameworks.
 * Use `parseTestOutput(output)` — it auto-detects the framework and dispatches.
 *
 * Supported:
 *   - Bun test
 *   - Jest / Vitest
 *   - pytest        (FAILED lines + file:line stackTrace from verbose FAILURES block)
 *   - go test       (--- FAIL: lines + file:line:msg from indented error lines)
 *   - Unknown       (common-parser fallback via broad regexes)
 */

import { detectFramework, stripAnsi } from "./detector";
import { parseMochaOutput } from "./parse-mocha";
import { parseRustTestOutput } from "./parse-rust";
import type { TestFailure, TestOutputAnalysis, TestSummary } from "./types";

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
  const clean = stripAnsi(output);
  const framework = detectFramework(clean);
  switch (framework) {
    case "bun":
      return parseBunOutput(clean);
    case "jest":
    case "vitest":
      return parseJestOutput(clean);
    case "pytest":
      return parsePytestOutput(clean);
    case "go":
      return parseGoTestOutput(clean);
    case "rust":
      return parseRustTestOutput(clean);
    case "mocha":
      return parseMochaOutput(clean);
    default:
      return parseCommonOutput(clean);
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
    // Do not increment failed here. In verbose mode, the ✗ glyph line above already
    // counted this failure. In batch mode, no ✗ lines are emitted — the summary-line
    // backstop below (Math.max) corrects the count from the authoritative summary.
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

  // Backstop: bun summary lines are authoritative — they are the canonical source of truth.
  // The summary is more reliable than per-line counts because it's the global total.
  // Bun summary can appear in multiple formats:
  //   "X pass, Y fail [duration]"  (batch output)
  //   "X passed, Y failed [duration]"  (verbose output)
  //   "X tests passed [duration]"  (all-pass output)
  // Match the last occurrence of each to handle multi-file runs.
  const summaryPassMatches = Array.from(output.matchAll(/^\s*(\d+)\s+(?:tests?\s+)?(?:pass|passed)\b.*$/gm));
  const summaryFailMatches = Array.from(output.matchAll(/^\s*(\d+)\s+(?:fail|failed)\b.*$/gm));
  if (summaryPassMatches.length > 0) {
    passed = Math.max(passed, Number.parseInt(summaryPassMatches[summaryPassMatches.length - 1][1], 10));
  }
  if (summaryFailMatches.length > 0) {
    failed = Math.max(failed, Number.parseInt(summaryFailMatches[summaryFailMatches.length - 1][1], 10));
  }

  // BUG-060: If we have no summary fail count but have failures from (fail) lines,
  // use the failure count as the backstop. This handles truncated output (e.g. OOM kill,
  // crash mid-run) where bun never emitted the summary line.
  if (summaryFailMatches.length === 0 && failures.length > failed) {
    failed = failures.length;
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
    // Skip "● Console" — Jest uses this as a section header for captured console output,
    // not as a test failure. It is not a real failure and must not enter the failure list.
    const bulletMatch = line.match(/^\s+●\s+(.+)$/);
    if (bulletMatch) {
      const testName = bulletMatch[1].trim();
      if (testName === "Console") {
        i++;
        continue;
      }
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

  // Jest output repeats FAIL <file> headers in multiple sections (run-summary and
  // per-file detail), sometimes with different path forms (e.g. "src/foo.spec.ts"
  // vs "foo.spec.ts"). Deduplicate by testName to prevent inflated failure counts.
  const seen = new Set<string>();
  const dedupedFailures = failures.filter((f) => {
    const key = f.testName;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { passed, failed, failures: dedupedFailures };
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
 * Verbose format adds a FAILURES block with per-test sections:
 * ```
 * ================================= FAILURES =================================
 * ________________________________ test_bar __________________________________
 *     def test_bar():
 * >       assert 1 == 2
 * E       AssertionError: assert 1 == 2
 *
 * tests/test_foo.py:5: AssertionError
 * ```
 * The file:line reference at the end of each section is extracted into stackTrace.
 */
function parsePytestOutput(output: string): TestSummary {
  const common = parseCommonOutput(output);

  // Structured failure names from "FAILED path::test_name - reason" lines.
  // Allow a leading turbo-style task prefix ("pkg:test: FAILED ...") so the
  // anchor survives monorepo aggregate output.
  const failures: TestFailure[] = [];
  for (const line of output.split("\n")) {
    const m = line.match(/^(?:\S+:\s+)?FAILED\s+(\S+)(?:\s+-\s+(.*))?$/);
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

  // Collection/import errors come in two line-anchored forms (both tolerate a
  // leading turbo task prefix like "pkg:test: "):
  //   - ERRORS block header:  "____ ERROR collecting <path> ____"
  //   - short summary:        "ERROR <path>[::test] - <reason>"
  // Requiring either the "collecting" keyword or a " - <reason>" tail keeps
  // captured app-log lines (e.g. "ERROR app.py:42 boom") from manufacturing
  // phantom failures. Dedupe by file, preferring the entry carrying a reason.
  const PLACEHOLDER_REASON = "Collection/import error";
  const errorByFile = new Map<string, TestFailure>();
  for (const line of output.split("\n")) {
    const collecting = line.match(/^(?:\S+:\s+)?_*\s*ERROR\s+collecting\s+(\S+\.\w+)/);
    const summary = line.match(/^(?:\S+:\s+)?ERROR\s+(\S+\.\w+(?:::\S+)?)\s+-\s+(.*)/);
    const location = collecting?.[1] ?? summary?.[1];
    if (!location) continue;
    const reason = summary?.[2]?.trim();
    const file = location.split("::")[0] ?? location;
    const existing = errorByFile.get(file);
    if (existing && existing.error !== PLACEHOLDER_REASON) continue;
    errorByFile.set(file, {
      file,
      testName: `collection error: ${file}`,
      error: reason || PLACEHOLDER_REASON,
      stackTrace: [],
    });
  }
  failures.push(...errorByFile.values());

  // Merge file:line stackTrace entries from the verbose FAILURES block
  const verboseStacks = parsePytestVerboseStacks(output);
  for (const failure of failures) {
    const leafName = failure.testName.split(" > ").pop() ?? failure.testName;
    // Class-based tests: FAILED line yields "TestClass > test_method" but the verbose
    // block header uses "TestClass.test_method" (dot separator). Try both forms.
    const stack =
      verboseStacks.get(leafName) ??
      verboseStacks.get(failure.testName) ??
      verboseStacks.get(failure.testName.replace(/ > /g, "."));
    if (stack && stack.length > 0) {
      failure.stackTrace = stack;
    }
  }

  return {
    passed: common.passed,
    failed: common.failed,
    failures: failures.length > 0 ? failures : common.failures,
  };
}

/**
 * Extract a map of testName → stackTrace entries from the pytest verbose FAILURES block.
 *
 * Block headers look like: "____ test_name ____" (4+ underscores padding each side).
 * Class-based test headers use dot notation: "____ TestClass.test_method ____".
 * File:line references look like: "tests/foo.py:10: AssertionError" (bare, unindented).
 *
 * Known limitation: if two test files both define a function with the same name (e.g.
 * both define `test_foo`), the map key collides and the last block wins. The wrong
 * stackTrace may be assigned to one of the failures. This is a minor edge case that
 * would require full file-path correlation to resolve.
 */
function parsePytestVerboseStacks(output: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  const failuresIdx = output.indexOf("FAILURES");
  if (failuresIdx === -1) return result;

  let currentTest: string | null = null;
  for (const line of output.slice(failuresIdx).split("\n")) {
    const headerMatch = line.match(/^_{4,}\s+(.+?)\s+_{4,}$/);
    if (headerMatch) {
      currentTest = headerMatch[1].trim();
      continue;
    }
    if (currentTest) {
      // "tests/test_foo.py:10: AssertionError" — bare (unindented) file:line reference
      const fileLineMatch = line.match(/^(\S+\.py):(\d+):/);
      if (fileLineMatch) {
        const entry = `${fileLineMatch[1]}:${fileLineMatch[2]}`;
        const existing = result.get(currentTest) ?? [];
        result.set(currentTest, [...existing, entry]);
      }
    }
  }

  return result;
}

/**
 * Parse `go test` output.
 *
 * Example format:
 * ```
 * --- FAIL: TestFoo (0.00s)
 *     foo_test.go:12: Error message
 *     foo_test.go:13: additional context
 * ok  	example.com/pkg	0.042s
 * FAIL	example.com/pkg	0.001s
 * ```
 *
 * Indented lines directly following "--- FAIL:" carry the file:line:message details.
 * The first such line populates `file` and `error`; all lines populate `stackTrace`.
 * Subtests (e.g. "TestSuite/SubTest_one") are preserved verbatim as testName.
 */
function parseGoTestOutput(output: string): TestSummary {
  const common = parseCommonOutput(output);

  const failures: TestFailure[] = [];
  const lines = output.split("\n");
  let i = 0;

  while (i < lines.length) {
    const failMatch = lines[i].match(/^--- FAIL:\s+(\S+)\s+\([\d.]+s\)/);
    if (failMatch) {
      const testName = failMatch[1];
      i++;

      const errorLines: Array<{ file: string; lineNum: string; msg: string }> = [];
      while (i < lines.length) {
        const line = lines[i];
        if (!line.trim()) {
          i++;
          continue;
        }
        // Indented error line: "    foo_test.go:12: message" (4+ spaces)
        const errMatch = line.match(/^\s{4,}(\S+\.go):(\d+):\s+(.+)$/);
        if (errMatch) {
          errorLines.push({ file: errMatch[1], lineNum: errMatch[2], msg: errMatch[3] });
          i++;
        } else {
          break;
        }
      }

      failures.push({
        file: errorLines[0]?.file ?? "unknown",
        testName,
        error: errorLines[0]?.msg ?? "Unknown error",
        stackTrace: errorLines.map((e) => `${e.file}:${e.lineNum}: ${e.msg}`),
      });
      continue;
    }
    i++;
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

  // pytest categorises collection/import/fixture problems as "errors" — a bucket
  // distinct from "failed" but equally fatal to the suite (e.g.
  // "230 passed, 10 errors in 5.29s"). Fold the error count into `failed` so the
  // suite is not reported as all-green. This runs for ALL frameworks
  // (analyzeTestExitCode calls parseCommonOutput directly), so the match is
  // tightly scoped to the pytest summary tail via a lookahead: the count must be
  // immediately followed by "... in <n>s" on the same line. That excludes
  // incidental phrasing like "passed in 1.2s (4 errors suppressed)" and app-log
  // noise. Last matching count wins, mirroring the pass/fail rule above.
  const errorMatches = Array.from(output.matchAll(/(\d+)\s+errors?\b(?=[^\n]*\bin\s+[\d.]+\s*s\b)/gi));
  if (errorMatches.length > 0) {
    failed += Number.parseInt(errorMatches[errorMatches.length - 1][1], 10);
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
export type { TestFailure, TestSummary, TestOutputAnalysis } from "./types";
