/**
 * Mocha spec-reporter output parser (also covers Cypress, which uses Mocha's
 * reporter). Pure function — no I/O, no throws.
 *
 * Failure detail blocks are parsed only from the region after the "N failing"
 * summary line, so the inline tree's "N) name" markers are not double-counted.
 */
import type { TestFailure, TestSummary } from "./types";

const MAX_STACK_LINES = 5;

export function parseMochaOutput(output: string): TestSummary {
  return {
    passed: matchCount(output, /(\d+)\s+passing\b/),
    failed: matchCount(output, /(\d+)\s+failing\b/),
    failures: extractMochaFailures(output),
  };
}

function matchCount(output: string, re: RegExp): number {
  const m = output.match(re);
  return m ? Number.parseInt(m[1], 10) : 0;
}

function extractMochaFailures(output: string): TestFailure[] {
  const failingIdx = output.search(/^\s*\d+\s+failing\b/m);
  if (failingIdx === -1) return [];
  const lines = output.slice(failingIdx).split("\n");
  const failures: TestFailure[] = [];

  for (let i = 1; i < lines.length; i++) {
    const header = lines[i].match(/^\s*(\d+)\)\s+(.+)$/);
    if (!header) continue;
    const testName = header[2].replace(/:\s*$/, "").trim();

    let file = "unknown";
    let error = "";
    const stackTrace: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (/^\s*\d+\)\s+/.test(line)) break; // next failure block
      const at = line.match(/at\s+.*\(([^)]+):(\d+):(\d+)\)/);
      if (at) {
        if (file === "unknown") file = at[1];
        if (stackTrace.length < MAX_STACK_LINES) stackTrace.push(`${at[1]}:${at[2]}`);
        continue;
      }
      if (!error && line.trim()) error = line.trim();
    }
    failures.push({ file, testName, error: error || "Unknown error", stackTrace });
  }
  return failures;
}
