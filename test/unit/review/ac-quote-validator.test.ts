/**
 * Tests for AC Quote Validator (Issue #930 Part 1)
 */

import { describe, expect, test } from "bun:test";
import {
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
    test("error with no acQuote → missing_ac_quote", () => {
      const finding = makeFinding({ severity: "error" });
      expect(validateAcQuote(finding, ACS)).toEqual({ valid: false, code: "missing_ac_quote" });
    });

    test("critical with empty acQuote → missing_ac_quote", () => {
      const finding = makeFinding({ severity: "critical", acQuote: "   " });
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

    test("acQuote without backticks matches AC text that has backtick formatting", () => {
      // Regression: adversarial reviewer dropped backticks when copying AC text verbatim.
      // The validator must normalise inline markdown before substring matching so that
      // `planInteractiveOp` in the AC matches planInteractiveOp in the quote.
      const backtickAcs = [
        "`planInteractiveOp` is a `RunOperation` exported from `src/operations/plan.ts` with `kind: \"run\"`.",
        "The `jsonRepair` method must return a non-empty string containing the word JSON.",
      ];
      const finding: AcQuotable = {
        severity: "error",
        file: "src/operations/plan.ts",
        issue: "planInteractiveOp is not exported",
        // acQuote is the AC text with backticks stripped — as the LLM commonly produces
        acQuote: "planInteractiveOp is a RunOperation exported from src/operations/plan.ts",
        acIndex: 1,
      };
      expect(validateAcQuote(finding, backtickAcs)).toEqual({ valid: true });
    });

    test("acQuote with backticks also matches AC text that has backtick formatting", () => {
      const backtickAcs = [
        "`planInteractiveOp` is a `RunOperation` exported from `src/operations/plan.ts`.",
      ];
      const finding: AcQuotable = {
        severity: "error",
        file: "src/operations/plan.ts",
        issue: "planInteractiveOp missing",
        acQuote: "`planInteractiveOp` is a `RunOperation` exported from `src/operations/plan.ts`",
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

// ─── filterByAcQuote ──────────────────────────────────────────────────────────

describe("filterByAcQuote", () => {
  test("empty findings → empty accepted and dropped", () => {
    const result = filterByAcQuote([], ACS);
    expect(result.accepted).toHaveLength(0);
    expect(result.dropped).toHaveLength(0);
  });

  test("non-blocking findings always accepted", () => {
    const findings: AcQuotable[] = [
      makeFinding({ severity: "warning" }),
      makeFinding({ severity: "info" }),
      makeFinding({ severity: "unverifiable" }),
    ];
    const result = filterByAcQuote(findings, ACS);
    expect(result.accepted).toHaveLength(3);
    expect(result.dropped).toHaveLength(0);
  });

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

  test("dropped entry preserves the original finding reference", () => {
    const finding = makeFinding({ severity: "error", issue: "sentinel-issue" });
    const result = filterByAcQuote([finding], ACS);
    expect(result.dropped[0].finding.issue).toBe("sentinel-issue");
  });

  test("critical severity is also subject to validation", () => {
    const findings = [makeFinding({ severity: "critical" })];
    const result = filterByAcQuote(findings, ACS);
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
    test("error with no acIndex → missing_ac_index", () => {
      const finding = makeFinding({ severity: "error" });
      expect(validateAcGroundingMinimal(finding, ACS)).toEqual({ valid: false, code: "missing_ac_index" });
    });

    test("critical with acIndex 0 → missing_ac_index", () => {
      const finding = makeFinding({ severity: "critical", acIndex: 0 });
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
  test("empty findings → empty accepted and dropped", () => {
    const result = filterByAcGroundingMinimal([], ACS);
    expect(result.accepted).toHaveLength(0);
    expect(result.dropped).toHaveLength(0);
  });

  test("non-blocking findings always accepted", () => {
    const findings: AcQuotable[] = [
      makeFinding({ severity: "warning" }),
      makeFinding({ severity: "info" }),
      makeFinding({ severity: "unverifiable" }),
    ];
    const result = filterByAcGroundingMinimal(findings, ACS);
    expect(result.accepted).toHaveLength(3);
    expect(result.dropped).toHaveLength(0);
  });

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

  test("dropped entry preserves the original finding reference", () => {
    const finding = makeFinding({ severity: "error", issue: "sentinel-issue-minimal" });
    const result = filterByAcGroundingMinimal([finding], ACS);
    expect(result.dropped[0].finding.issue).toBe("sentinel-issue-minimal");
  });

  test("critical severity is also subject to validation", () => {
    const findings = [makeFinding({ severity: "critical" })];
    const result = filterByAcGroundingMinimal(findings, ACS);
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
