import { describe, expect, test } from "bun:test";
import { isFinishReviewShape, MISSING_REVIEW, parseFinishReviewReply } from "@/finish/review-json";

describe("parseFinishReviewReply", () => {
  test("maps a JSON reply onto Finding with the lens as source", () => {
    const reply = JSON.stringify({
      findings: [
        {
          severity: "high",
          title: "Unwired",
          problem: "new fn never called",
          fix: "call it",
          file: "src/a.ts",
          line: 4,
        },
      ],
      covered: ["src/a.ts"],
    });
    expect(parseFinishReviewReply(reply, "quality")).toEqual({
      findings: [
        {
          severity: "HIGH",
          title: "Unwired",
          problem: "new fn never called",
          fix: "call it",
          file: "src/a.ts",
          line: 4,
          source: "quality",
        },
      ],
      covered: ["src/a.ts"],
    });
  });

  test("normalises unknown and info severities to LOW and a missing fix to empty", () => {
    const reply = JSON.stringify({
      findings: [
        { severity: "info", title: "a", problem: "p" },
        { severity: "weird", title: "b", problem: "p" },
      ],
      covered: [],
    });
    const out = parseFinishReviewReply(reply, "spec");
    expect(out?.findings.map((f) => [f.severity, f.fix])).toEqual([
      ["LOW", ""],
      ["LOW", ""],
    ]);
  });

  test("keeps judgment fields and multi-line summary, trims title", () => {
    const reply =
      '{"findings":[{"severity":"MEDIUM","title":"t","problem":"p","fix":"f","judgment":true,"judgmentReason":"spec vs code"}],' +
      '"covered":[],"title":"  feat(x): add y  ","summary":"line one\\nline two"}';
    const out = parseFinishReviewReply(reply, "quality");
    expect(out?.findings[0]?.judgment).toBe(true);
    expect(out?.findings[0]?.judgmentReason).toBe("spec vs code");
    expect(out?.title).toBe("feat(x): add y");
    expect(out?.summary).toBe("line one\nline two");
  });

  test("drops findings missing title or problem, and non-string covered entries", () => {
    const reply = JSON.stringify({
      findings: [
        { severity: "LOW", title: "", problem: "p" },
        { severity: "LOW", title: "ok", problem: "p" },
      ],
      covered: ["a.ts", 3, null],
    });
    const out = parseFinishReviewReply(reply, "spec");
    expect(out?.findings.map((f) => f.title)).toEqual(["ok"]);
    expect(out?.covered).toEqual(["a.ts"]);
  });

  test("returns null for prose and for an object without a findings array", () => {
    expect(parseFinishReviewReply("I looked at the diff and it is fine.", "spec")).toBeNull();
    expect(parseFinishReviewReply('{"covered":[]}', "spec")).toBeNull();
  });

  test("isFinishReviewShape and MISSING_REVIEW", () => {
    expect(isFinishReviewShape({ findings: [], covered: [] })).toBe(true);
    expect(isFinishReviewShape({ findings: "no" })).toBe(false);
    expect(MISSING_REVIEW).toEqual({ findings: [], covered: [], missing: true });
  });
});
