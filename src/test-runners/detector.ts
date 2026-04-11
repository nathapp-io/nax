/**
 * Test Framework Detector
 *
 * Single source of truth for identifying which test runner produced a given output.
 * Used by both parseTestOutput() (structured summary) and parseTestFailures() (AC-ID extraction).
 */

export type Framework = "bun" | "jest" | "vitest" | "pytest" | "go" | "unknown";

/**
 * Detect the test framework that produced the given output.
 *
 * Inspects summary lines and failure markers to identify the runner.
 * Returns "unknown" when no framework can be confidently detected — callers
 * should apply all known patterns as a fallback in that case.
 */
export function detectFramework(output: string): Framework {
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
