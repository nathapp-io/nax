/**
 * Runtime Crash Detector — BUG-070
 *
 * Detects Bun runtime crashes in test output so they can be classified as
 * RUNTIME_CRASH rather than TEST_FAILURE, preventing spurious tier escalation.
 *
 * STUB — implementation is intentionally absent. Tests are RED until
 * the real logic is written.
 */

/**
 * Known patterns emitted by the Bun runtime before any test results
 * when a crash occurs (segfault, panic, etc.).
 */
export const CRASH_PATTERNS = [
  "panic(main thread)",
  "Segmentation fault",
  "Bun has crashed",
  "oh no: Bun has crashed",
] as const;

/**
 * Detect whether the given test runner output contains a Bun runtime crash.
 *
 * Returns true if any known crash pattern is found in the output.
 * These patterns are emitted by Bun itself before any test result lines.
 *
 * @param output - Raw stdout/stderr from the test runner
 */
export function detectRuntimeCrash(output: string | undefined | null): boolean {
  // STUB: not implemented yet — always returns false
  if (!output) return false;
  return CRASH_PATTERNS.some((pattern) => output.includes(pattern));
}
