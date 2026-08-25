/**
 * outputAdvisoryFindingsSummary() — §2.1 headless console surfacing of
 * sub-threshold review findings.
 */

import type { Mock } from "bun:test";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { outputAdvisoryFindingsSummary } from "@/execution";
import type { AdvisoryFindingSummaryEntry } from "@/runtime";

function makeFinding(overrides: Partial<AdvisoryFindingSummaryEntry> = {}): AdvisoryFindingSummaryEntry {
  return {
    storyId: "US-001",
    reviewer: "adversarial",
    severity: "warning",
    issue: "off-AC edge case not handled",
    ...overrides,
  };
}

describe("outputAdvisoryFindingsSummary", () => {
  let logSpy: Mock<typeof console.log>;
  let origLog: typeof console.log;

  beforeEach(() => {
    origLog = console.log;
    logSpy = mock<typeof console.log>(() => {});
    console.log = logSpy;
  });

  afterEach(() => {
    console.log = origLog;
  });

  test("does nothing when there are no findings", () => {
    outputAdvisoryFindingsSummary([], "normal");
    expect(logSpy).not.toHaveBeenCalled();
  });

  test("does nothing in json mode (findings live in the review-audit trail instead)", () => {
    outputAdvisoryFindingsSummary([makeFinding()], "json");
    expect(logSpy).not.toHaveBeenCalled();
  });

  test("prints the formatted summary in normal mode", () => {
    outputAdvisoryFindingsSummary([makeFinding()], "normal");
    expect(logSpy).toHaveBeenCalledTimes(1);
    const output = logSpy.mock.calls[0][0] as string;
    expect(output).toContain("US-001");
  });
});
