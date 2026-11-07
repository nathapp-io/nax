/**
 * Test Framework Detector
 *
 * Single source of truth for identifying which test runner produced a given output.
 * Used by both parseTestOutput() (structured summary) and parseTestFailures() (AC-ID extraction).
 */

export type Framework = "bun" | "jest" | "vitest" | "pytest" | "go" | "rust" | "mocha" | "unknown";

/**
 * Strip ANSI CSI escape sequences (e.g. `\x1b[32m` SGR color, `\x1b[0m` reset,
 * `\x1b[2K` erase-line, cursor-movement codes) from output.
 *
 * Real-world test-runner output (Mocha, Cypress, cargo, vitest's live reporter)
 * is frequently colorized and/or interleaved with cursor/erase control codes.
 * An escape sequence sitting between a line-start anchor (`^\s*`) and the digits
 * it expects defeats every anchored summary regex in this module and in the
 * per-framework parsers — so callers strip once, up front, before matching.
 *
 * Deliberately broad (any CSI final byte, not just `m`): this is the single
 * shared ANSI-stripping helper for `src/test-runners/` — see
 * `.claude/rules/monorepo-awareness.md` §C "one source of truth per concept".
 */
export function stripAnsi(output: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching the ESC (0x1b) control byte is the point of this function
  return output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
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
