/**
 * Tests for AC Quote Validator (Issue #930 Part 1)
 */

import { describe, expect, test } from "bun:test";
import {
  type AcDroppedEntry,
  type AcGroundingMinimalRejection,
  type AcQuotable,
  filterByAcGroundingMinimal,
  filterByAcQuote,
  validateAcGroundingMinimal,
  validateAcQuote,
} from "../../../src/review/ac-quote-validator";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ACS = [
  "The validateAcQuote function must return a rejection code when acQuote is absent",
  "The filterByAcQuote function must drop all error findings without a valid acQuote",
  "Warning and info findings must pass through without acQuote validation",
];

function makeFinding(overrides: Partial<AcQuotable> & { severity: string }): AcQuotable {
  return {
    file: "src/review/ac-quote-validator.ts",
    issue: "validateAcQuote does not check acQuote presence",
    acQuote: undefined,
    acIndex: undefined,
    ...overrides,
  };
}

// ─── validateAcQuote ──────────────────────────────────────────────────────────

describe("validateAcQuote", () => {
  describe("non-blocking severities bypass validation", () => {
    test.each(["warning", "info", "unverifiable", "low"] as const)("%s severity → valid", (severity) => {
      const finding = makeFinding({ severity });
      expect(validateAcQuote(finding, ACS)).toEqual({ valid: true });
    });
  });

  describe("blocking severities require acQuote", () => {
    test.each([
      ["error with no acQuote", makeFinding({ severity: "error" })],
      ["critical with whitespace-only acQuote", makeFinding({ severity: "critical", acQuote: "   " })],
    ] as const)("%s → missing_ac_quote", (_label, finding) => {
      expect(validateAcQuote(finding, ACS)).toEqual({ valid: false, code: "missing_ac_quote" });
    });

    test.each([0, 99])("error with acIndex %d → ac_index_out_of_range", (acIndex) => {
      const finding = makeFinding({ severity: "error", acQuote: "validateAcQuote", acIndex });
      expect(validateAcQuote(finding, ACS)).toEqual({ valid: false, code: "ac_index_out_of_range" });
    });

    test("error with acQuote not in AC text → ac_quote_not_substring", () => {
      const finding = makeFinding({
        severity: "error",
        acQuote: "this text is not in any AC",
        acIndex: 1,
      });
      expect(validateAcQuote(finding, ACS)).toEqual({ valid: false, code: "ac_quote_not_substring" });
    });

    test("error with valid acQuote but no locus keyword in quote → ac_quote_does_not_constrain_locus", () => {
      // AC 3 text contains "Warning" and "info" but the file being flagged is
      // something like "src/random-unrelated.ts" with no shared token in the quote
      const finding = makeFinding({
        severity: "error",
        file: "src/xyzzy-module.ts",
        issue: "xyzzy function missing",
        acQuote: "Warning and info findings must pass",
        acIndex: 3,
      });
      expect(validateAcQuote(finding, ACS)).toEqual({
        valid: false,
        code: "ac_quote_does_not_constrain_locus",
      });
    });

    test("error with valid acQuote and matching locus keyword → valid", () => {
      const finding = makeFinding({
        severity: "error",
        file: "src/review/ac-quote-validator.ts",
        issue: "validateAcQuote does not return rejection code",
        acQuote: "validateAcQuote function must return a rejection code",
        acIndex: 1,
      });
      expect(validateAcQuote(finding, ACS)).toEqual({ valid: true });
    });

    test("acQuote match is case-insensitive", () => {
      const finding = makeFinding({
        severity: "error",
        file: "src/review/ac-quote-validator.ts",
        issue: "validateAcQuote check broken",
        acQuote: "VALIDATEACQUOTE FUNCTION MUST RETURN A REJECTION CODE",
        acIndex: 1,
      });
      expect(validateAcQuote(finding, ACS)).toEqual({ valid: true });
    });

    test("acQuote with extra internal whitespace is normalised and matches", () => {
      const finding = makeFinding({
        severity: "error",
        file: "src/review/ac-quote-validator.ts",
        issue: "validateAcQuote not checked",
        acQuote: "validateAcQuote  function   must return",
        acIndex: 1,
      });
      expect(validateAcQuote(finding, ACS)).toEqual({ valid: true });
    });

    test.each([
      ["without backticks", "planInteractiveOp is a RunOperation exported from src/operations/plan.ts"],
      ["with backticks", "`planInteractiveOp` is a `RunOperation` exported from `src/operations/plan.ts`"],
    ] as const)("acQuote %s matches AC text that has backtick formatting", (_label, acQuote) => {
      const backtickAcs = [
        "`planInteractiveOp` is a `RunOperation` exported from `src/operations/plan.ts`.",
      ];
      const finding: AcQuotable = {
        severity: "error",
        file: "src/operations/plan.ts",
        issue: "planInteractiveOp is not exported",
        acQuote,
        acIndex: 1,
      };
      expect(validateAcQuote(finding, backtickAcs)).toEqual({ valid: true });
    });

    test("no acceptanceCriteria → ac_index_out_of_range", () => {
      const finding = makeFinding({ severity: "error", acQuote: "something", acIndex: 1 });
      expect(validateAcQuote(finding, [])).toEqual({ valid: false, code: "ac_index_out_of_range" });
    });

    test("finding with no file uses only issue-token as locus → valid when keyword present", () => {
      const finding: AcQuotable = {
        severity: "error",
        issue: "filterByAcQuote not dropping findings",
        acQuote: "filterByAcQuote function must drop all error findings",
        acIndex: 2,
      };
      expect(validateAcQuote(finding, ACS)).toEqual({ valid: true });
    });
  });
});

// ─── shared filter behaviors ──────────────────────────────────────────────────

const FILTER_FNS = [
  ["filterByAcQuote", filterByAcQuote],
  ["filterByAcGroundingMinimal", filterByAcGroundingMinimal],
] as const;

test.each(FILTER_FNS)("%s — empty findings → empty accepted and dropped", (_name, fn) => {
  const result = fn([], ACS);
  expect(result.accepted).toHaveLength(0);
  expect(result.dropped).toHaveLength(0);
});

test.each(FILTER_FNS)("%s — non-blocking findings always accepted", (_name, fn) => {
  const findings: AcQuotable[] = [
    makeFinding({ severity: "warning" }),
    makeFinding({ severity: "info" }),
    makeFinding({ severity: "unverifiable" }),
  ];
  const result = fn(findings, ACS);
  expect(result.accepted).toHaveLength(3);
  expect(result.dropped).toHaveLength(0);
});

test.each([
  ["filterByAcQuote (missing_ac_quote)", filterByAcQuote, makeFinding({ severity: "error", issue: "sentinel" }), "missing_ac_quote"],
  ["filterByAcGroundingMinimal (missing_ac_index)", filterByAcGroundingMinimal, makeFinding({ severity: "error", issue: "sentinel-minimal" }), "missing_ac_index"],
] as const)("%s — dropped entry preserves original finding reference", (_name, fn, finding, code) => {
  const result = fn([finding], ACS);
  expect(result.dropped[0].finding.issue).toBe(finding.issue);
  expect(result.dropped[0].code).toBe(code);
});

// ─── filterByAcQuote ──────────────────────────────────────────────────────────

describe("filterByAcQuote", () => {

  test("error finding without acQuote is dropped with missing_ac_quote", () => {
    const findings = [makeFinding({ severity: "error" })];
    const result = filterByAcQuote(findings, ACS);
    expect(result.accepted).toHaveLength(0);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0].code).toBe("missing_ac_quote");
  });

  test("error finding with valid acQuote is accepted", () => {
    const findings = [
      makeFinding({
        severity: "error",
        file: "src/review/ac-quote-validator.ts",
        issue: "validateAcQuote broken",
        acQuote: "validateAcQuote function must return a rejection code",
        acIndex: 1,
      }),
    ];
    const result = filterByAcQuote(findings, ACS);
    expect(result.accepted).toHaveLength(1);
    expect(result.dropped).toHaveLength(0);
  });

  test("mixed findings: valid errors accepted, invalid errors dropped, non-blocking pass through", () => {
    const findings: AcQuotable[] = [
      // Valid error
      makeFinding({
        severity: "error",
        file: "src/review/ac-quote-validator.ts",
        issue: "validateAcQuote broken",
        acQuote: "validateAcQuote function must return a rejection code",
        acIndex: 1,
      }),
      // Invalid error (no acQuote)
      makeFinding({ severity: "error" }),
      // Non-blocking — always pass
      makeFinding({ severity: "warning" }),
    ];
    const result = filterByAcQuote(findings, ACS);
    expect(result.accepted).toHaveLength(2);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0].code).toBe("missing_ac_quote");
  });


  test("preserves concrete AdversarialLLMFinding shape (category field)", () => {
    type AdversarialShape = AcQuotable & { category: string };
    const finding: AdversarialShape = {
      severity: "error",
      file: "src/review/ac-quote-validator.ts",
      issue: "validateAcQuote broken",
      category: "convention",
      acQuote: "validateAcQuote function must return a rejection code",
      acIndex: 1,
    };
    const result = filterByAcQuote([finding], ACS);
    expect(result.accepted).toHaveLength(1);
    expect((result.accepted[0] as AdversarialShape).category).toBe("convention");
  });
});

// ─── validateAcGroundingMinimal ───────────────────────────────────────────────

describe("validateAcGroundingMinimal", () => {
  describe("non-blocking severities bypass validation", () => {
    test.each(["warning", "info", "unverifiable", "low"] as const)("%s severity → valid", (severity) => {
      const finding = makeFinding({ severity });
      expect(validateAcGroundingMinimal(finding, ACS)).toEqual({ valid: true });
    });
  });

  describe("blocking severities require valid acIndex", () => {
    test.each([
      ["error with no acIndex", makeFinding({ severity: "error" })],
      ["critical with acIndex 0", makeFinding({ severity: "critical", acIndex: 0 })],
    ] as const)("%s → missing_ac_index", (_label, finding) => {
      expect(validateAcGroundingMinimal(finding, ACS)).toEqual({ valid: false, code: "missing_ac_index" });
    });

    test.each<[string, ReturnType<typeof makeFinding>, string[]]>([
      ["acIndex 99 in-range ACS", makeFinding({ severity: "error", acIndex: 99 }), ACS],
      ["acIndex 1 with empty ACS", makeFinding({ severity: "error", acIndex: 1 }), []],
    ])("ac_index_out_of_range for %s", (_label, finding, acs) => {
      expect(validateAcGroundingMinimal(finding, acs)).toEqual({ valid: false, code: "ac_index_out_of_range" });
    });

    // Contract regression test: acQuote content is NEVER inspected — only acIndex range matters
    test.each<[string, ReturnType<typeof makeFinding>]>([
      ["acQuote not in any AC", makeFinding({ severity: "error", acIndex: 1, acQuote: "this text is nowhere in any AC" })],
      ["no acQuote", makeFinding({ severity: "error", acIndex: 1 })],
      ["acIndex at last AC", makeFinding({ severity: "error", acIndex: ACS.length })],
    ])("valid for %s", (_label, finding) => {
      expect(validateAcGroundingMinimal(finding, ACS)).toEqual({ valid: true });
    });
  });
});

// ─── filterByAcGroundingMinimal ───────────────────────────────────────────────

describe("filterByAcGroundingMinimal", () => {
  test("error finding without acIndex is dropped with missing_ac_index", () => {
    const findings = [makeFinding({ severity: "error" })];
    const result = filterByAcGroundingMinimal(findings, ACS);
    expect(result.accepted).toHaveLength(0);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0].code).toBe("missing_ac_index");
  });

  test("error finding with acIndex out of range is dropped with ac_index_out_of_range", () => {
    const findings = [makeFinding({ severity: "error", acIndex: 99 })];
    const result = filterByAcGroundingMinimal(findings, ACS);
    expect(result.accepted).toHaveLength(0);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0].code).toBe("ac_index_out_of_range");
  });

  test("error finding with valid acIndex and bogus acQuote is accepted", () => {
    const findings = [makeFinding({ severity: "error", acIndex: 1, acQuote: "completely made up text" })];
    const result = filterByAcGroundingMinimal(findings, ACS);
    expect(result.accepted).toHaveLength(1);
    expect(result.dropped).toHaveLength(0);
  });

  test("mixed: valid error accepted, no-acIndex error dropped, non-blocking pass through", () => {
    const findings: AcQuotable[] = [
      makeFinding({ severity: "error", acIndex: 1 }),
      makeFinding({ severity: "error" }),
      makeFinding({ severity: "warning" }),
    ];
    const result = filterByAcGroundingMinimal(findings, ACS);
    expect(result.accepted).toHaveLength(2);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0].code).toBe("missing_ac_index");
  });

  test("preserves concrete AdversarialLLMFinding shape (category field)", () => {
    type AdversarialShape = AcQuotable & { category: string };
    const finding: AdversarialShape = {
      severity: "error",
      file: "src/review/ac-quote-validator.ts",
      issue: "minimal check broken",
      category: "convention",
      acIndex: 1,
    };
    const result = filterByAcGroundingMinimal([finding], ACS);
    expect(result.accepted).toHaveLength(1);
    expect((result.accepted[0] as AdversarialShape).category).toBe("convention");
  });
});
