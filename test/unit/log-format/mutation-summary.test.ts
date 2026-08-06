import { describe, expect, test } from "bun:test";
import { formatMutationSummary } from "@/log-format";
import type { MutationStorySummary } from "@/runtime";

function makeSummary(overrides: Partial<MutationStorySummary> = {}): MutationStorySummary {
  return {
    storyId: "US-004",
    survivors: [
      {
        file: "src/calculator.ts",
        line: 42,
        before: "+",
        after: "-",
        operatorId: "ts:arith-add-sub",
        outcome: "survived",
      },
    ],
    outcomes: { killed: 0, survived: 1, errored: 0 },
    ...overrides,
  };
}

describe("formatMutationSummary", () => {
  test("US-004 AC1: is callable", () => {
    expect(typeof formatMutationSummary).toBe("function");
  });

  test.each([
    ["US-004 AC2: includes the survivor file path", "src/calculator.ts"],
    ["US-004 AC3: includes the survivor line number", "42"],
    ["US-004 AC4: includes the survivor operator ID", "ts:arith-add-sub"],
    ["US-004 AC5: includes the story ID", "US-004"],
  ])("%s", (_name, expected) => {
    expect(formatMutationSummary([makeSummary()])).toContain(expected);
  });

  test("US-004 AC6: returns an empty string for no summaries", () => {
    expect(formatMutationSummary([])).toBe("");
  });

  test("US-004 AC7: returns an empty string when summaries contain no survivors", () => {
    const summary = makeSummary({
      survivors: [],
      outcomes: { killed: 2, survived: 0, errored: 1 },
    });

    expect(formatMutationSummary([summary])).toBe("");
  });

  test("US-004 AC8: includes survivors from multiple story summaries", () => {
    const second = makeSummary({
      storyId: "US-005",
      survivors: [
        {
          file: "src/second.ts",
          line: 7,
          before: "true",
          after: "false",
          operatorId: "ts:bool-flip",
          outcome: "survived",
        },
      ],
    });

    expect(formatMutationSummary([makeSummary(), second])).toContain("src/second.ts");
  });
});
