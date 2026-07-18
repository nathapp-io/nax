/**
 * Test Framework Detector
 *
 * Single source of truth for identifying which test runner produced a given output.
 * Used by both parseTestOutput() (structured summary) and parseTestFailures() (AC-ID extraction).
 *
 * Also exports isTestFile() — language-agnostic test file classification used across
 * the pipeline (autofix scope routing, TDD isolation, diff analysis).
 */

import { isTestFileByPatterns } from "./conventions";

export type Framework = "bun" | "jest" | "vitest" | "pytest" | "go" | "rust" | "mocha" | "unknown";

/**
 * Language-agnostic patterns that identify test files. Covers:
 * - Directory segments: test/, tests/, __tests__/, spec/, specs/
 * - Extension-based: .test.<ext>, .spec.<ext>, .e2e-spec.<ext>
 * - Go suffix: _test.go
 * - Python prefix: test_<name>.py
 */
const TEST_FILE_PATTERNS = [
  /(?:^|\/)(?:test|tests|__tests__|specs?)(?:\/|$)/, // dir segment — any language
  /\.test\.\w+$/, // foo.test.ts, foo.test.py
  /\.spec\.\w+$/, // foo.spec.ts, foo.spec.rb
  /\.e2e-spec\.\w+$/, // foo.e2e-spec.ts
  /_test\.go$/, // Go: foo_test.go
  /(?:^|\/)test_[^/]+$/, // Python: test_foo.py
];

/**
 * Returns true when the given file path looks like a test file.
 *
 * When `testFilePatterns` is supplied, delegates to `isTestFileByPatterns()`
 * (config-aware path — ADR-009 preferred usage). When omitted, falls back to
 * the broad language-agnostic regex (backward-compat Phase 1 path).
 *
 * All first-party call sites have been migrated to the resolver + classifier
 * pattern (ADR-009). The no-argument form is kept as a Phase 1 backward-compat
 * shim for any third-party plugins that import it directly; it will be removed
 * in Phase 2 once detection guarantees the resolver always yields patterns.
 */
export function isTestFile(filePath: string, testFilePatterns?: readonly string[]): boolean {
  if (testFilePatterns !== undefined) {
    return isTestFileByPatterns(filePath, testFilePatterns);
  }
  return TEST_FILE_PATTERNS.some((pattern) => pattern.test(filePath));
}

/**
 * Map a test command string to a human-readable framework hint for agent prompts.
 *
 * Centralised in src/test-runners/ so callers (e.g. prompt builders) do not
 * inline language-detection logic outside the SSOT module (ADR-009).
 */
export function buildTestFrameworkHint(testCommand: string): string {
  const cmd = testCommand.trim();
  // #543: do not assume Bun when no command is configured — that falsely tells
  // Go / Python / Rust packages to run `bun test`.
  if (!cmd) return "Use your project's test framework";
  if (cmd.startsWith("bun test")) return "Use Bun test (describe/test/expect)";
  if (cmd.startsWith("pytest") || cmd.startsWith("python -m pytest")) return "Use pytest";
  if (cmd.startsWith("cargo test")) return "Use Rust's cargo test";
  if (cmd.startsWith("go test")) return "Use Go's testing package";
  if (cmd.includes("vitest")) return "Use Vitest (describe/test/expect)";
  if (cmd.includes("jest") || cmd === "npm test" || cmd === "yarn test") return "Use Jest (describe/test/expect)";
  return "Use your project's test framework";
}

/**
 * Strip ANSI color/style escape sequences (e.g. `\x1b[32m`, `\x1b[0m`) from output.
 *
 * Real-world test-runner output (Mocha, Cypress, cargo) is frequently colorized.
 * An ANSI escape sitting between a line-start anchor (`^\s*`) and the digits it
 * expects defeats every anchored summary regex in this module and in the
 * per-framework parsers — so callers strip once, up front, before matching.
 */
export function stripAnsi(output: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching the ESC (0x1b) control byte is the point of this function
  return output.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Detect the test framework that produced the given output.
 *
 * Inspects summary lines and failure markers to identify the runner.
 * Returns "unknown" when no framework can be confidently detected — callers
 * should apply all known patterns as a fallback in that case.
 */
export function detectFramework(output: string): Framework {
  const clean = stripAnsi(output);
  // Vitest: "Test Files  1 failed | 2 passed (3)"
  if (/^\s*Test Files\s+\d+/m.test(clean)) return "vitest";
  // Jest: "Tests:       41 failed, 38 passed, 79 total"
  if (/^\s*Tests:\s+\d+/m.test(clean)) return "jest";
  // pytest: "====== X failed, Y passed in Z.Zs ======"
  if (/={3,}\s+\d+\s+(?:failed|passed).*in\s+[\d.]+s\s*={3,}/m.test(clean)) return "pytest";
  // go test: "--- FAIL:" or "ok  \t" or "FAIL\t"
  if (/^--- (?:FAIL|PASS):/m.test(clean) || /^(?:ok|FAIL)\s+\t/m.test(clean)) return "go";
  // Rust cargo test: "test result:" summary or a panic line — unique anchors.
  if (/^test result:\s+(?:ok|FAILED)\./m.test(clean) || /panicked at /.test(clean)) return "rust";
  // Mocha (and Cypress) spec reporter: "N passing". MUST precede the bun check —
  // mocha's spec reporter also prints the ✓/✗ glyphs the bun branch matches.
  if (/^\s*\d+\s+passing\b/m.test(clean)) return "mocha";
  // Bun: "(fail)" marker, bun test header, or bun's Unicode checkmarks (✓ ✔ ✗ ✘)
  if (/^\(fail\)\s/m.test(clean) || /^bun test/m.test(clean) || /[✓✔✗✘]/m.test(clean)) return "bun";
  return "unknown";
}
