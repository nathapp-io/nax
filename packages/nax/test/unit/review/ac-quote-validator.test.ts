/**
 * Tests for AC Quote Validator (Issue #930 Part 1)
 */

import { describe, expect, test } from "bun:test";
import {
  type AcQuotable,
  filterByAcGroundingMinimal,
  filterByAcQuote,
  filterByScopeQuote,
  validateAcGroundingMinimal,
  validateAcQuote,
  validateScopeQuote,
} from "@/review/ac-quote-validator";

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

    describe("test-gap carve-out (placeholder/fake tests — #2)", () => {
      // A fake test (`expect(true).toBe(true)`) covering an AC cannot name a
      // symbol from the AC in its quote — the whole point is the test verifies
      // nothing. The carve-out waives only the locus-keyword requirement; the
      // acIndex + substring checks still apply.
      test("test-gap error with valid acQuote but NO locus keyword → valid (waived)", () => {
        const finding = makeFinding({
          severity: "error",
          category: "test-gap",
          file: "test/unit/execution/story-orchestrator-gates.test.ts",
          issue: "every test body is expect(true).toBe(true) — AC behaviour unverified",
          acQuote: "must return a rejection code when acQuote is absent",
          acIndex: 1,
        });
        expect(validateAcQuote(finding, ACS)).toEqual({ valid: true });
      });

      test("test-gap error still requires acQuote to be a substring of the AC", () => {
        const finding = makeFinding({
          severity: "error",
          category: "test-gap",
          file: "test/unit/foo.test.ts",
          issue: "placeholder test",
          acQuote: "this text is not in any AC",
          acIndex: 1,
        });
        expect(validateAcQuote(finding, ACS)).toEqual({ valid: false, code: "ac_quote_not_substring" });
      });

      test("test-gap error still requires acIndex in range", () => {
        const finding = makeFinding({
          severity: "error",
          category: "test-gap",
          acQuote: "must return a rejection code",
          acIndex: 0,
        });
        expect(validateAcQuote(finding, ACS)).toEqual({ valid: false, code: "ac_index_out_of_range" });
      });

      test("non-test-gap category with no locus keyword is still dropped (carve-out is scoped)", () => {
        const finding = makeFinding({
          severity: "error",
          category: "convention",
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
      const backtickAcs = ["`planInteractiveOp` is a `RunOperation` exported from `src/operations/plan.ts`."];
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
  [
    "filterByAcQuote (missing_ac_quote)",
    filterByAcQuote,
    makeFinding({ severity: "error", issue: "sentinel" }),
    "missing_ac_quote",
  ],
  [
    "filterByAcGroundingMinimal (missing_ac_index)",
    filterByAcGroundingMinimal,
    makeFinding({ severity: "error", issue: "sentinel-minimal" }),
    "missing_ac_index",
  ],
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
      [
        "acQuote not in any AC",
        makeFinding({ severity: "error", acIndex: 1, acQuote: "this text is nowhere in any AC" }),
      ],
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

// ─── Scope grounding ──────────────────────────────────────────────────────────

describe("validateScopeQuote", () => {
  const OUT_OF_SCOPE = ["An interactive Ink TUI", "Per-story diffs or `checkpoints`"];

  function scopeFinding(overrides: Partial<AcQuotable> = {}): AcQuotable {
    return {
      severity: "warning",
      category: "out-of-scope",
      file: "src/replay/tui.ts",
      issue: "Story added an Ink TUI",
      scopeQuote: "An interactive Ink TUI",
      scopeIndex: 1,
      ...overrides,
    };
  }

  test("accepts a verbatim quote of the indexed exclusion", () => {
    expect(validateScopeQuote(scopeFinding(), OUT_OF_SCOPE)).toEqual({ valid: true });
  });

  test("accepts a partial substring of the indexed exclusion", () => {
    expect(validateScopeQuote(scopeFinding({ scopeQuote: "Ink TUI" }), OUT_OF_SCOPE).valid).toBe(true);
  });

  test("ignores backtick and whitespace formatting differences", () => {
    const f = scopeFinding({ scopeQuote: "Per-story   diffs or checkpoints", scopeIndex: 2 });
    expect(validateScopeQuote(f, OUT_OF_SCOPE).valid).toBe(true);
  });

  test("rejects a quote that is not a substring of the indexed exclusion", () => {
    const f = scopeFinding({ scopeQuote: "a REST API nobody deferred" });
    expect(validateScopeQuote(f, OUT_OF_SCOPE)).toEqual({ valid: false, code: "scope_quote_not_substring" });
  });

  test("rejects a quote pointing at the wrong exclusion", () => {
    const f = scopeFinding({ scopeQuote: "An interactive Ink TUI", scopeIndex: 2 });
    expect(validateScopeQuote(f, OUT_OF_SCOPE).code).toBe("scope_quote_not_substring");
  });

  test("rejects an out-of-range or 0-based scopeIndex", () => {
    expect(validateScopeQuote(scopeFinding({ scopeIndex: 0 }), OUT_OF_SCOPE).code).toBe("scope_index_out_of_range");
    expect(validateScopeQuote(scopeFinding({ scopeIndex: 9 }), OUT_OF_SCOPE).code).toBe("scope_index_out_of_range");
    expect(validateScopeQuote(scopeFinding({ scopeIndex: undefined }), OUT_OF_SCOPE).code).toBe(
      "scope_index_out_of_range",
    );
  });

  test("rejects a citation when the story declares no exclusions", () => {
    expect(validateScopeQuote(scopeFinding(), []).code).toBe("no_out_of_scope_declared");
  });

  test("rejects an empty scopeQuote", () => {
    expect(validateScopeQuote(scopeFinding({ scopeQuote: "   " }), OUT_OF_SCOPE).code).toBe("missing_scope_quote");
  });

  test("accepts a scope finding with no citation (description-level Scope bullet)", () => {
    const f = scopeFinding({ scopeQuote: undefined, scopeIndex: undefined });
    expect(validateScopeQuote(f, OUT_OF_SCOPE)).toEqual({ valid: true });
    expect(validateScopeQuote(f, []).valid).toBe(true);
  });

  test("validates at every severity, unlike the blocking-only AC gate", () => {
    for (const severity of ["error", "warning", "info", "unverifiable"]) {
      const f = scopeFinding({ severity, scopeQuote: "never declared anywhere" });
      expect(validateScopeQuote(f, OUT_OF_SCOPE).valid).toBe(false);
    }
  });

  test("ignores findings that make no scope claim", () => {
    const acFinding: AcQuotable = { severity: "error", category: "input", issue: "x", acQuote: "y", acIndex: 1 };
    expect(validateScopeQuote(acFinding, OUT_OF_SCOPE)).toEqual({ valid: true });
    expect(validateScopeQuote(acFinding, [])).toEqual({ valid: true });
  });
});

describe("filterByScopeQuote", () => {
  const OUT_OF_SCOPE = ["An interactive Ink TUI"];

  test("drops ungrounded scope findings and keeps the rest", () => {
    const findings: AcQuotable[] = [
      {
        severity: "warning",
        category: "out-of-scope",
        issue: "a",
        scopeQuote: "An interactive Ink TUI",
        scopeIndex: 1,
      },
      {
        severity: "warning",
        category: "out-of-scope",
        issue: "b",
        scopeQuote: "a boundary nobody wrote",
        scopeIndex: 1,
      },
      { severity: "error", category: "input", issue: "c", acQuote: "x", acIndex: 1 },
    ];

    const { accepted, dropped } = filterByScopeQuote(findings, OUT_OF_SCOPE);

    expect(accepted.map((f) => f.issue)).toEqual(["a", "c"]);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].code).toBe("scope_quote_not_substring");
  });

  test("passes everything through when no finding claims a scope violation", () => {
    const findings: AcQuotable[] = [{ severity: "error", category: "input", issue: "c", acQuote: "x", acIndex: 1 }];
    const { accepted, dropped } = filterByScopeQuote(findings, []);
    expect(accepted).toHaveLength(1);
    expect(dropped).toHaveLength(0);
  });
});

describe("filterByScopeQuote — non-scope findings are never collateral", () => {
  const OUT_OF_SCOPE = ["No Ink TUI — deferred to arc 3"];

  test("keeps an AC-grounded blocking finding that volunteered a bad scopeQuote", () => {
    // Regression: `scopeQuote` is advertised top-level in the output schema, so
    // models volunteer it on unrelated findings. Treating that as a scope claim
    // deleted genuine blocking findings and silently passed the story.
    const finding: AcQuotable = {
      severity: "error",
      category: "input",
      file: "src/timeout.ts",
      issue: "parseTimeout accepts NaN",
      acQuote: "parseTimeout must reject NaN",
      acIndex: 1,
      scopeQuote: "the Ink TUI is deferred", // paraphrased, ungroundable
      scopeIndex: 1,
    };

    const { accepted, dropped } = filterByScopeQuote([finding], OUT_OF_SCOPE);

    expect(dropped).toHaveLength(0);
    expect(accepted).toHaveLength(1);
    expect(accepted[0].severity).toBe("error");
    expect(accepted[0].acQuote).toBe("parseTimeout must reject NaN");
  });

  test("strips the unverified citation so nothing downstream reads it as grounding", () => {
    const finding: AcQuotable = {
      severity: "warning",
      category: "convention",
      issue: "i",
      scopeQuote: "invented",
      scopeIndex: 4,
    };

    const { accepted } = filterByScopeQuote([finding], OUT_OF_SCOPE);

    expect(accepted[0].scopeQuote).toBeUndefined();
    expect(accepted[0].scopeIndex).toBeUndefined();
  });

  test("leaves a clean non-scope finding untouched (same reference)", () => {
    const finding: AcQuotable = { severity: "error", category: "input", issue: "i", acQuote: "q", acIndex: 1 };
    expect(filterByScopeQuote([finding], OUT_OF_SCOPE).accepted[0]).toBe(finding);
  });

  test("rejects a quote too short to ground anything", () => {
    const finding: AcQuotable = {
      severity: "warning",
      category: "out-of-scope",
      issue: "i",
      scopeQuote: "No",
      scopeIndex: 1,
    };
    expect(validateScopeQuote(finding, ["No telemetry"]).code).toBe("missing_scope_quote");
  });
});
