/**
 * Rust `cargo test` (libtest) output parser.
 *
 * Pure function — no I/O, no throws. Unmatched output yields zero counts and an
 * empty failures array. Counts are SUMMED across all `test result:` lines because
 * cargo emits one per test binary (multi-crate runs would otherwise undercount).
 */
import type { TestFailure, TestSummary } from "./types";

const RESULT_LINE_RE = /^test result:\s+(?:ok|FAILED)\.\s+(\d+)\s+passed;\s+(\d+)\s+failed;/gm;
const FAILED_TEST_LINE_RE = /^test (\S+) \.\.\. FAILED$/gm;
const MAX_STACK_LINES = 5;

export function parseRustTestOutput(output: string): TestSummary {
  let passed = 0;
  let failed = 0;
  for (const m of output.matchAll(RESULT_LINE_RE)) {
    passed += Number.parseInt(m[1], 10);
    failed += Number.parseInt(m[2], 10);
  }
  return { passed, failed, failures: extractRustFailures(output) };
}

function extractRustFailures(output: string): TestFailure[] {
  const lines = output.split("\n");
  const failures: TestFailure[] = [];

  for (let i = 0; i < lines.length; i++) {
    const header = lines[i].match(/^---- (\S+) stdout ----$/);
    if (!header) continue;
    const testName = header[1];

    let file = "unknown";
    let error = "";
    const stackTrace: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (/^---- \S+ stdout ----$/.test(line) || /^test result:/.test(line)) break;
      const panic = line.match(/panicked at ([^:\n]+):(\d+):(?:\d+):/);
      if (panic) {
        file = panic[1];
        if (stackTrace.length < MAX_STACK_LINES) stackTrace.push(`${panic[1]}:${panic[2]}`);
        continue;
      }
      if (!error && line.trim() && !line.startsWith("note:")) error = line.trim();
    }
    failures.push({ file, testName, error: error || "Unknown error", stackTrace });
  }

  if (failures.length > 0) return failures;

  // Degrade: no detail blocks, but "test <name> ... FAILED" lines present.
  for (const m of output.matchAll(FAILED_TEST_LINE_RE)) {
    failures.push({ file: "unknown", testName: m[1], error: "Unknown error", stackTrace: [] });
  }
  return failures;
}
