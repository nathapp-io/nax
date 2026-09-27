/**
 * US-002: checkAcceptanceCoverage — warn on an AC-count gap without gating.
 *
 * The check is advisory. It must log one warn naming the gap, return the same
 * numbers, and never throw — no matter how empty the source is.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AcceptanceCoverageEntry } from "@/acceptance";
import { checkAcceptanceCoverage } from "@/acceptance";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";

const COVERAGE_WARN = "Acceptance test file does not cover every AC";

const TEST_PATH = ".nax/features/test-feature/.nax-acceptance.test.ts";

let captured: LogEntry[];
let unsubscribe: (() => void) | null = null;

beforeEach(() => {
  captured = [];
  resetLogger();
  initLogger({ level: "debug", suppressConsole: true });
  unsubscribe = addSink((entry) => {
    captured.push(entry);
  });
});

afterEach(() => {
  unsubscribe?.();
  unsubscribe = null;
  resetLogger();
});

function coverageWarns(): LogEntry[] {
  return captured.filter((entry) => entry.level === "warn" && entry.message === COVERAGE_WARN);
}

describe("US-002 checkAcceptanceCoverage: gap warning", () => {
  test("AC8: covers 3 of 5 → one warn and an entry with the same three numbers", () => {
    const source = ['test("AC-1: a", () => {})', 'test("AC-2: b", () => {})', 'test("AC-3: c", () => {})'].join("\n");

    const entry: AcceptanceCoverageEntry = checkAcceptanceCoverage({
      testPath: TEST_PATH,
      source,
      expected: 5,
      storyId: "US-001",
    });

    const warns = coverageWarns();
    expect(warns).toHaveLength(1);
    expect(warns[0]?.data).toMatchObject({
      storyId: "US-001",
      testPath: TEST_PATH,
      expected: 5,
      found: 3,
      missing: ["AC-4", "AC-5"],
    });

    expect(entry.testPath).toBe(TEST_PATH);
    expect(entry.expected).toBe(5);
    expect(entry.found).toBe(3);
    expect(entry.missing).toEqual(["AC-4", "AC-5"]);
  });

  test("AC9: full coverage → no warn, found equals expected, nothing missing", () => {
    const source = [
      'test("AC-1: a", () => {})',
      'test("AC-2: b", () => {})',
      'test("AC-3: c", () => {})',
      'test("AC-4: d", () => {})',
    ].join("\n");

    const entry = checkAcceptanceCoverage({ testPath: TEST_PATH, source, expected: 4, storyId: "US-001" });

    expect(coverageWarns()).toHaveLength(0);
    expect(entry.found).toBe(entry.expected);
    expect(entry.missing).toEqual([]);
  });

  test("AC10: an empty source does not throw and reports every criterion missing", () => {
    const run = (): AcceptanceCoverageEntry =>
      checkAcceptanceCoverage({ testPath: TEST_PATH, source: "", expected: 2 });

    expect(run).not.toThrow();

    const entry = run();
    expect(entry.found).toBe(0);
    expect(entry.missing).toEqual(["AC-1", "AC-2"]);
  });
});
