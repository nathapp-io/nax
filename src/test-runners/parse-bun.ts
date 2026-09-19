/**
 * Bun `bun test` output parser.
 *
 * Pure function — no I/O, no throws. Split out of parser.ts so the Bun
 * layout's extraction logic has room to live beside its own regexes, and to
 * match the one-file-per-framework shape of parse-mocha.ts / parse-rust.ts.
 */
import type { TestFailure, TestSummary } from "./types";

export function parseBunOutput(output: string): TestSummary {
  const lines = output.split("\n");
  const failures: TestFailure[] = [];
  let passed = 0;
  let failed = 0;
  let currentFile = "";
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Extract file path from headers like "test/example.test.ts:" — also matches
    // .test.tsx/.spec.ts/.test.mts/.test.cts, not just .test.ts/.test.js.
    if (/\.(?:test|spec)\.[cm]?[jt]sx?:$/.test(line.trim())) {
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
    // Anchored to end-of-line with a greedy capture, so a name containing its own
    // "[Nms]"-shaped substring captures up to the LAST duration marker.
    const failMatch = line.match(/^\(fail\)\s+(.+)\s+\[[\d.]+m?s\]\s*$/);
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
