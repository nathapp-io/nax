/**
 * Bun `bun test` output parser.
 *
 * Pure function — no I/O, no throws.
 *
 * Real `bun test v1.4.0` layout — note the message precedes the `(fail)` line:
 * ```
 * test/example.test.ts:
 * 1 | import { test, expect } from "bun:test";
 * 2 | test("adds", () => { expect(1 + 2).toBe(4); });
 *                                        ^
 * error: expect(received).toBe(expected)
 *
 * Expected: 4
 * Received: 3
 *
 *       at <anonymous> (/abs/path/example.test.ts:2:40)
 * (fail) adds [0.12ms]
 *
 *  0 pass
 *  1 fail
 * ```
 */
import type { TestFailure, TestSummary } from "./types";

/** Emitted when a `(fail)` line has no recoverable message block above it.
 *  An explicit admission beats a borrowed line: a stray line sends the agent
 *  chasing an unrelated file, which is the failure mode this parser caused. */
const NO_MESSAGE = "no assertion message captured";

const MAX_STACK_LINES = 5;
/** A Bun code-frame line: "  12 | const x = 1;" */
const CODE_FRAME_RE = /^\s*\d+\s*\|/;
/** The caret line Bun prints under the failing expression. */
const CARET_RE = /^\^+$/;
/** Node stderr that can interleave anywhere, e.g. "(node:79387) Warning: …" */
const NODE_STDERR_RE = /^\(node:\d+\)/;
/** The "Expected:" / "Received:" pair Bun prints under the `error:` line. */
const EXPECTATION_RE = /^(?:Expected|Received):/;
/** A test-file header line, e.g. "test/foo.test.ts:" */
const FILE_HEADER_RE = /\.(?:test|spec)\.[cm]?[jt]sx?:$/;

/**
 * True when `trimmed` ends the message block belonging to the failure below it.
 *
 * A block is bounded above by the previous failure's `(fail)` line, by a
 * per-test pass/fail glyph (verbose mode), or by the file header. Stopping at
 * these is what keeps one failure from borrowing another's message.
 */
function isBlockBoundary(trimmed: string): boolean {
  if (/^\(fail\)\s/.test(trimmed)) return true;
  if (/[✓✔✗✘]/.test(trimmed)) return true;
  if (FILE_HEADER_RE.test(trimmed)) return true;
  return false;
}

/**
 * Collect the failure detail printed ABOVE `failIndex`.
 *
 * Bun's layout is: code frame, caret, `error: <message>`, blank,
 * `Expected:` / `Received:`, blank, `at …` frames, then `(fail) <name>`.
 * Scanning forward from `(fail)` — as this parser did until 2026-09-19 —
 * lands in the NEXT failure's code frame, and on the last failure lands in
 * the summary. Hence the backward walk.
 */
function extractBunFailureDetail(lines: string[], failIndex: number): { error: string; stackTrace: string[] } {
  const block: string[] = [];
  for (let j = failIndex - 1; j >= 0; j--) {
    if (isBlockBoundary(lines[j].trim())) break;
    block.unshift(lines[j]);
  }

  let errorLine = "";
  const expectation: string[] = [];
  const stackTrace: string[] = [];

  for (const raw of block) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (CODE_FRAME_RE.test(raw)) continue;
    if (CARET_RE.test(trimmed)) continue;
    if (NODE_STDERR_RE.test(trimmed)) continue;
    if (trimmed.startsWith("at ")) {
      if (stackTrace.length < MAX_STACK_LINES) stackTrace.push(trimmed);
      continue;
    }
    if (EXPECTATION_RE.test(trimmed)) {
      expectation.push(trimmed);
      continue;
    }
    if (!errorLine) errorLine = trimmed.replace(/^error:\s*/i, "");
  }

  const parts = [errorLine, ...expectation].filter(Boolean);
  return { error: parts.length > 0 ? parts.join(" ") : NO_MESSAGE, stackTrace };
}

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
      const detail = extractBunFailureDetail(lines, i);
      failures.push({
        file: currentFile || "unknown",
        testName,
        error: detail.error,
        stackTrace: detail.stackTrace,
      });
      i++;
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
