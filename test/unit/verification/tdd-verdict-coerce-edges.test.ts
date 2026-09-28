/**
 * verdict-reader.ts — characterisation tests for coerceVerdict branches the
 * tdd-verdict mirror leaves unpinned, written before the complexity drain
 * refactor (docs/plans/STATUS-complexity-drain.md, batch C2). Every assertion
 * below is green against the unrefactored coercion; the tests pin behaviour,
 * not implementation.
 */

import { describe, expect, test } from "bun:test";
import type { TestFailureDiagnosis } from "@/tdd/verdict";
import { coerceVerdict } from "@/tdd/verdict-reader";

const VALID_DIAGNOSIS: TestFailureDiagnosis = {
  cause: "implementation",
  assertions: [{ file: "src/a.test.ts", testName: "does the thing", reasoning: "still red" }],
};

describe("coerceVerdict — approval tokens", () => {
  test("'APPROVED' is accepted as an approval token", () => {
    expect(coerceVerdict({ verdict: "APPROVED" })?.approved).toBe(true);
  });

  test("a boolean approved:true is an approval signal on its own (asserted directly)", () => {
    expect(coerceVerdict({ approved: true })?.approved).toBe(true);
  });
});

describe("coerceVerdict — reasoning fallback chain", () => {
  test("a string obj.reasoning wins over every other source", () => {
    const result = coerceVerdict({
      verdict: "PASS",
      overall_status: "SHOULD NOT WIN",
      verification_summary: { overall_status: "SHOULD NOT WIN EITHER" },
      reasoning: "explicit reasoning",
    });
    expect(result?.reasoning).toBe("explicit reasoning");
  });

  test("falls back to a string obj.overall_status when obj.reasoning is absent", () => {
    const result = coerceVerdict({ verdict: "PASS", overall_status: "ALL GREEN" });
    expect(result?.reasoning).toBe("ALL GREEN");
  });

  test("falls back to summary.overall_status when neither obj field carries a string", () => {
    const result = coerceVerdict({
      verdict: "PASS",
      verification_summary: { overall_status: "READY" },
    });
    expect(result?.reasoning).toBe("READY");
  });

  test("defaults to the 'Coerced from free-form verdict:' message with the UPPERCASED verdict", () => {
    const result = coerceVerdict({ verdict: "pass" });
    expect(result?.reasoning).toBe("Coerced from free-form verdict: PASS");
  });
});

describe("coerceVerdict — acceptance criteria sources", () => {
  test("allMet defaults to the approval value when no criteria source exists", () => {
    expect(coerceVerdict({ verdict: "PASS" })?.acceptanceCriteria.allMet).toBe(true);
    expect(coerceVerdict({ verdict: "FAIL" })?.acceptanceCriteria.allMet).toBe(false);
  });

  test("a review entry with met:true (and no status) counts as met", () => {
    const result = coerceVerdict({
      verdict: "FAIL",
      acceptance_criteria_review: {
        criterion_1: { name: "First", met: true },
        criterion_2: { name: "Second" },
      },
    });
    expect(result?.acceptanceCriteria.criteria[0]?.met).toBe(true);
    expect(result?.acceptanceCriteria.criteria[1]?.met).toBe(false);
  });

  test("criterion text falls back to the entry's criterion field, then to the review key", () => {
    const result = coerceVerdict({
      verdict: "PASS",
      acceptance_criteria_review: {
        criterion_1: { criterion: "From criterion field", status: "SATISFIED" },
        criterion_2: { status: "SATISFIED" },
      },
    });
    expect(result?.acceptanceCriteria.criteria[0]?.criterion).toBe("From criterion field");
    expect(result?.acceptanceCriteria.criteria[1]?.criterion).toBe("criterion_2");
  });

  test("evidence becomes a note truncated to 200 chars; absent evidence leaves the note undefined", () => {
    const longEvidence = "e".repeat(250);
    const result = coerceVerdict({
      verdict: "PASS",
      acceptance_criteria_review: {
        criterion_1: { name: "With evidence", status: "SATISFIED", evidence: longEvidence },
        criterion_2: { name: "Without evidence", status: "SATISFIED" },
      },
    });
    expect(result?.acceptanceCriteria.criteria[0]?.note).toBe("e".repeat(200));
    expect(result?.acceptanceCriteria.criteria[1]?.note).toBeUndefined();
  });

  test("a top-level acceptanceCriteria object overrides allMet and its criteria are merged as-is", () => {
    const merged = { criterion: "merged criterion", met: false };
    const result = coerceVerdict({
      verdict: "PASS",
      acceptanceCriteria: { allMet: false, criteria: [merged] },
    });
    expect(result?.acceptanceCriteria.allMet).toBe(false);
    expect(result?.acceptanceCriteria.criteria[0]).toEqual(merged);
  });

  test("quirk pinned: top-level criteria entries with met:false do NOT flip a true allMet", () => {
    const result = coerceVerdict({
      verdict: "PASS",
      acceptanceCriteria: { allMet: true, criteria: [{ criterion: "unmet", met: false }] },
    });
    expect(result?.acceptanceCriteria.allMet).toBe(true);
    expect(result?.acceptanceCriteria.criteria[0]?.met).toBe(false);
  });

  test("a summary '4/4 SATISFIED' count sets allMet only when met equals total", () => {
    const met = coerceVerdict({ verdict: "FAIL", verification_summary: { acceptance_criteria: "4/4 SATISFIED" } });
    const unmet = coerceVerdict({ verdict: "FAIL", verification_summary: { acceptance_criteria: "3/4 SATISFIED" } });
    expect(met?.acceptanceCriteria.allMet).toBe(true);
    expect(unmet?.acceptanceCriteria.allMet).toBe(false);
  });
});

describe("coerceVerdict — quality sources", () => {
  test("an obj.quality object's rating is used when the summary carries no code_quality", () => {
    const result = coerceVerdict({ verdict: "PASS", quality: { rating: "poor", issues: ["x"] } });
    expect(result?.quality.rating).toBe("poor");
  });

  test("an unrecognised quality value resolves to the acceptable default", () => {
    const result = coerceVerdict({ verdict: "PASS", verification_summary: { code_quality: "meh" } });
    expect(result?.quality.rating).toBe("acceptable");
  });
});

describe("coerceVerdict — remaining coerced fields", () => {
  test("a fixes array is carried; a non-array fixes becomes an empty array", () => {
    const carried = coerceVerdict({ verdict: "PASS", fixes: ["fix one", "fix two"] });
    expect(carried?.fixes).toEqual(["fix one", "fix two"]);
    const replaced = coerceVerdict({ verdict: "PASS", fixes: "not an array" });
    expect(replaced?.fixes).toEqual([]);
  });

  test("a well-formed testFailureDiagnosis is carried; a malformed one is dropped", () => {
    const carried = coerceVerdict({ verdict: "PASS", testFailureDiagnosis: VALID_DIAGNOSIS });
    expect(carried?.testFailureDiagnosis).toEqual(VALID_DIAGNOSIS);
    const dropped = coerceVerdict({
      verdict: "PASS",
      testFailureDiagnosis: { cause: "bogus", assertions: [] },
    });
    expect(dropped?.testFailureDiagnosis).toBeUndefined();
  });

  test("the fail-closed testModifications placeholder is always fabricated", () => {
    const result = coerceVerdict({ verdict: "PASS" });
    expect(result?.testModifications).toEqual({
      detected: false,
      files: [],
      legitimate: true,
      reasoning: "Not assessed in free-form verdict",
    });
  });

  test("a non-string test_results in the summary parses no ratio and leaves counts at zero", () => {
    const result = coerceVerdict({
      verdict: "PASS",
      verification_summary: { test_results: 45 },
    });
    expect(result?.tests).toEqual({ allPassing: false, passCount: 0, failCount: 0 });
  });

  test("a non-object tests value is ignored rather than throwing", () => {
    const result = coerceVerdict({ verdict: "PASS", tests: "45 tests passed" });
    expect(result?.tests.passCount).toBe(0);
  });
});
