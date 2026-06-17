import { describe, expect, test } from "bun:test";
import { llmFindingToReviewFinding, llmFindingsToReviewFindings } from "../../../src/review";
// LLMFinding / AdversarialLLMFinding are import-type only (erased at compile
// time) so leaf-path imports here do not cause singleton fragmentation.
import type { LLMFinding } from "../../../src/review/semantic-helpers";
import type { AdversarialLLMFinding } from "../../../src/review/adversarial-helpers";

describe("llmFindingToReviewFinding", () => {
  test("joins issue and suggestion into message with arrow separator", () => {
    const f: LLMFinding = {
      severity: "error",
      file: "src/foo.ts",
      line: 12,
      issue: "X is not validated",
      suggestion: "guard with typeof",
    };
    const rf = llmFindingToReviewFinding(f);
    expect(rf.message).toBe("X is not validated\n→ guard with typeof");
  });

  test("uses bare issue when suggestion is empty", () => {
    const f: LLMFinding = {
      severity: "warning",
      file: "src/foo.ts",
      line: 1,
      issue: "subtle bug",
      suggestion: "",
    };
    expect(llmFindingToReviewFinding(f).message).toBe("subtle bug");
  });

  test("derives ruleId from category + slug of leading issue tokens", () => {
    const f: AdversarialLLMFinding = {
      severity: "error",
      category: "input",
      file: "src/api.ts",
      line: 4,
      issue: "Listener arg not validated as function",
      suggestion: "",
    };
    const rf = llmFindingToReviewFinding(f);
    expect(rf.ruleId).toBe("input:listener-arg-not-validated-as-function");
  });

  test("ruleId falls back to 'review' when category missing", () => {
    const f: LLMFinding = {
      severity: "warning",
      file: "src/foo.ts",
      line: 1,
      issue: "ambiguous wording here",
      suggestion: "",
    };
    expect(llmFindingToReviewFinding(f).ruleId.startsWith("review:")).toBe(true);
  });

  test("ruleId clusters semantically-related findings (same category, same first 6 tokens)", () => {
    const a: AdversarialLLMFinding = {
      severity: "error", category: "input", file: "a.ts", line: 1,
      issue: "Listener arg not validated as function in handler", suggestion: "",
    };
    const b: AdversarialLLMFinding = {
      severity: "error", category: "input", file: "b.ts", line: 9,
      issue: "Listener arg not validated as function elsewhere", suggestion: "",
    };
    expect(llmFindingToReviewFinding(a).ruleId).toBe(llmFindingToReviewFinding(b).ruleId);
  });

  test("ruleId distinguishes different issues within the same category", () => {
    const a: AdversarialLLMFinding = {
      severity: "error", category: "input", file: "a.ts", line: 1,
      issue: "Listener arg not validated", suggestion: "",
    };
    const b: AdversarialLLMFinding = {
      severity: "error", category: "input", file: "b.ts", line: 9,
      issue: "Timeout value missing upper bound", suggestion: "",
    };
    expect(llmFindingToReviewFinding(a).ruleId).not.toBe(llmFindingToReviewFinding(b).ruleId);
  });

  test("normalizes 'warn' severity to 'warning'", () => {
    const f: LLMFinding = { severity: "warn", file: "x.ts", line: 1, issue: "y", suggestion: "" };
    expect(llmFindingToReviewFinding(f).severity).toBe("warning");
  });

  test("narrows unknown severity values to 'info'", () => {
    const f: LLMFinding = { severity: "huh", file: "x.ts", line: 1, issue: "y", suggestion: "" };
    expect(llmFindingToReviewFinding(f).severity).toBe("info");
  });

  test("downgrades 'unverifiable' severity to 'info' (ReviewFinding union excludes it)", () => {
    const f: LLMFinding = { severity: "unverifiable", file: "x.ts", line: 1, issue: "y", suggestion: "" };
    expect(llmFindingToReviewFinding(f).severity).toBe("info");
  });

  test("carries acQuote, acIndex, acId, verifiedBy, issue, suggestion into meta", () => {
    const f: LLMFinding = {
      severity: "error",
      file: "src/foo.ts",
      line: 7,
      issue: "raw issue",
      suggestion: "raw suggestion",
      acQuote: "must validate input",
      acIndex: 2,
      acId: "AC-3",
      verifiedBy: { file: "src/foo.ts", line: 7, observed: "no validation" },
    };
    const rf = llmFindingToReviewFinding(f);
    expect(rf.meta).toEqual({
      issue: "raw issue",
      suggestion: "raw suggestion",
      acQuote: "must validate input",
      acIndex: 2,
      acId: "AC-3",
      verifiedBy: { file: "src/foo.ts", line: 7, observed: "no validation" },
    });
  });

  test("includes issue in meta even without annotation fields", () => {
    const f: LLMFinding = { severity: "info", file: "x.ts", line: 1, issue: "y", suggestion: "" };
    const rf = llmFindingToReviewFinding(f);
    expect(rf.meta).toEqual({ issue: "y" });
  });

  test("does not treat acIndex: 0 as a valid AC anchor", () => {
    const f: LLMFinding = { severity: "warning", file: "x.ts", line: 1, issue: "y", suggestion: "", acIndex: 0 };
    const rf = llmFindingToReviewFinding(f);
    expect(rf.meta?.acIndex).toBeUndefined();
  });

  test("preserves originalSeverity in meta when severity is narrowed", () => {
    const f: LLMFinding = { severity: "unverifiable", file: "x.ts", line: 1, issue: "y", suggestion: "" };
    const rf = llmFindingToReviewFinding(f);
    expect(rf.severity).toBe("info");
    expect(rf.meta?.originalSeverity).toBe("unverifiable");
  });

  test("does not add originalSeverity to meta when severity is unchanged", () => {
    const f: LLMFinding = { severity: "warning", file: "x.ts", line: 1, issue: "y", suggestion: "" };
    const rf = llmFindingToReviewFinding(f);
    expect(rf.meta?.originalSeverity).toBeUndefined();
  });

  test("propagates source label when provided", () => {
    const f: LLMFinding = { severity: "error", file: "x.ts", line: 1, issue: "y", suggestion: "" };
    const rf = llmFindingToReviewFinding(f, { source: "semantic-review" });
    expect(rf.source).toBe("semantic-review");
  });

  test("semantic-review source preserves fixTarget=source when category is absent", () => {
    const f: LLMFinding = { severity: "error", file: "x.ts", line: 1, issue: "y", suggestion: "" };
    const rf = llmFindingToReviewFinding(f, { source: "semantic-review" });
    expect(rf.fixTarget).toBe("source");
  });

  test("empty issue produces 'unspecified' slug — documents intentional fallback bucket", () => {
    const f: LLMFinding = { severity: "warning", file: "x.ts", line: 1, issue: "", suggestion: "" };
    const rf = llmFindingToReviewFinding(f);
    expect(rf.ruleId).toBe("review:unspecified");
    expect(rf.message).toBe("");
  });

  test("punctuation-only issue also produces 'unspecified' slug", () => {
    const f: AdversarialLLMFinding = {
      severity: "warning", category: "input", file: "x.ts", line: 1,
      issue: "???", suggestion: "",
    };
    const rf = llmFindingToReviewFinding(f);
    expect(rf.ruleId).toBe("input:unspecified");
  });

  test("slug truncates at exactly 6 tokens regardless of input length", () => {
    const f: LLMFinding = {
      severity: "info", file: "x.ts", line: 1,
      issue: "a b c d e f g", suggestion: "",
    };
    const rf = llmFindingToReviewFinding(f);
    const slug = rf.ruleId.split(":")[1] ?? "";
    expect(slug).toBe("a-b-c-d-e-f");
    expect(slug.split("-").length).toBe(6);
  });
});

describe("llmFindingsToReviewFindings", () => {
  test("maps an array preserving order", () => {
    const fs: LLMFinding[] = [
      { severity: "error", file: "a.ts", line: 1, issue: "first", suggestion: "" },
      { severity: "info", file: "b.ts", line: 2, issue: "second", suggestion: "" },
    ];
    const rs = llmFindingsToReviewFindings(fs);
    expect(rs.map((r) => r.message)).toEqual(["first", "second"]);
  });

  test("returns empty array for empty input", () => {
    expect(llmFindingsToReviewFindings([])).toEqual([]);
  });
});
