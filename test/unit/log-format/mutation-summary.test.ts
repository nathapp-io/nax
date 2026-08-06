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
    candidates: 1,
    checked: true,
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

  test("US-004 AC9: renders NOT CHECKED for an attempted story with no candidates", () => {
    const summary = makeSummary({ storyId: "US-010", survivors: [], candidates: 0, checked: true });

    expect(formatMutationSummary([summary])).toContain("NOT CHECKED");
    expect(formatMutationSummary([summary])).toContain("US-010");
  });

  test("US-004 AC10: omits NOT CHECKED for disabled stories", () => {
    const summary = makeSummary({ survivors: [], candidates: 0, checked: false });

    expect(formatMutationSummary([summary])).not.toContain("NOT CHECKED");
  });

  test("US-004 AC11: renders survivors before NOT CHECKED stories", () => {
    const unchecked = makeSummary({ storyId: "US-010", survivors: [], candidates: 0, checked: true });

    const output = formatMutationSummary([makeSummary(), unchecked]);

    expect(output.indexOf("SURVIVING MUTANTS")).toBeLessThan(output.indexOf("NOT CHECKED"));
  });

  test("US-004 AC12: lists all attempted stories with no candidates", () => {
    const summaries = [
      makeSummary({ storyId: "US-010", survivors: [], candidates: 0, checked: true }),
      makeSummary({ storyId: "US-011", survivors: [], candidates: 0, checked: true }),
    ];

    const output = formatMutationSummary(summaries);

    expect(output).toContain("US-010");
    expect(output).toContain("US-011");
  });

  test("US-004 AC13: returns empty output when every story was unchecked", () => {
    const summary = makeSummary({ survivors: [], candidates: 0, checked: false });

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

describe("formatMutationSummary — WORKTREE NOT RESTORED", () => {
  const clean = () => makeSummary({ survivors: [], outcomes: { killed: 1, survived: 0, errored: 0 } });

  test("a story whose revert could not be confirmed is named", () => {
    const out = formatMutationSummary([makeSummary({ ...clean(), revertFailed: true })]);

    expect(out).toContain("WORKTREE NOT RESTORED");
    expect(out).toContain("US-004");
  });

  test("the block renders even when nothing survived and everything was checked", () => {
    // Otherwise the loudest condition would be the one that prints nothing.
    expect(formatMutationSummary([makeSummary({ ...clean(), revertFailed: true })])).not.toBe("");
  });

  test("a clean run never renders the block", () => {
    expect(formatMutationSummary([makeSummary()])).not.toContain("WORKTREE NOT RESTORED");
  });

  test("it is the last block, after survivors and not-checked", () => {
    const out = formatMutationSummary([
      makeSummary({ revertFailed: true }),
      makeSummary({ storyId: "US-006", survivors: [], candidates: 0 }),
    ]);

    expect(out.indexOf("WORKTREE NOT RESTORED")).toBeGreaterThan(out.indexOf("SURVIVING MUTANTS"));
    expect(out.indexOf("WORKTREE NOT RESTORED")).toBeGreaterThan(out.indexOf("NOT CHECKED"));
  });
});
