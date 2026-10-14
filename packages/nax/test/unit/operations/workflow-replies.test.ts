import { describe, expect, test } from "bun:test";
import {
  parseBranchReviewReply,
  parseImplementerReply,
  parseReReviewReply,
  parseStoryReviewReply,
  WORKFLOW_INTERRUPT_MARKER,
} from "@/operations/workflow-replies";

const fence = (o: unknown) => `Done.\n\n\`\`\`json\n${JSON.stringify(o)}\n\`\`\``;

describe("parseImplementerReply", () => {
  test("reads the trailing status block", () => {
    const r = parseImplementerReply(
      fence({ status: "DONE", commits: ["abc123"], testSummary: "12 pass", concerns: "" }),
    );
    expect(r).toEqual({ status: "DONE", commits: ["abc123"], testSummary: "12 pass", interrupted: false });
  });

  test("NEEDS_CONTEXT keeps its concern", () => {
    const r = parseImplementerReply(
      fence({ status: "NEEDS_CONTEXT", commits: [], testSummary: "", concerns: "Which DB?" }),
    );
    expect(r.status).toBe("NEEDS_CONTEXT");
    expect(r.concerns).toBe("Which DB?");
  });

  test("no status block -> DONE_WITH_CONCERNS (the work is the tree, not the reply)", () => {
    const r = parseImplementerReply("I changed some files.");
    expect(r.status).toBe("DONE_WITH_CONCERNS");
    expect(r.concerns).toContain("no status block");
  });

  test("unknown status -> DONE_WITH_CONCERNS", () => {
    expect(parseImplementerReply(fence({ status: "MAYBE" })).status).toBe("DONE_WITH_CONCERNS");
  });

  // US-001 (nax#2509): the flag the no-work ladder keys on.
  test("no status block -> noStatusBlock: true (US-001)", () => {
    const r = parseImplementerReply("I changed some files.");
    expect(r.noStatusBlock).toBe(true);
    expect(r.interrupted).toBe(false);
  });

  test("a valid status block carries no noStatusBlock key (US-001)", () => {
    const r = parseImplementerReply(fence({ status: "DONE", commits: ["abc123"], testSummary: "12 pass" }));
    expect("noStatusBlock" in r).toBe(false);
  });

  test("the interrupt marker carries no noStatusBlock key (US-001)", () => {
    const r = parseImplementerReply(WORKFLOW_INTERRUPT_MARKER);
    expect("noStatusBlock" in r).toBe(false);
  });

  test("a failed hop's reply carries no noStatusBlock key (US-001)", () => {
    const r = parseImplementerReply('Agent "native" failed: 503 upstream');
    expect("noStatusBlock" in r).toBe(false);
  });

  test("interrupt marker -> interrupted", () => {
    const r = parseImplementerReply(WORKFLOW_INTERRUPT_MARKER);
    expect(r.interrupted).toBe(true);
    expect(r.status).toBe("DONE_WITH_CONCERNS");
  });

  test("all-hops-failed text -> failure", () => {
    const r = parseImplementerReply('Agent "native" failed: 503 upstream');
    expect(r.failure).toBe('Agent "native" failed: 503 upstream');
  });
});

describe("parseStoryReviewReply", () => {
  test("keeps the reviewer's observed excerpt on a finding (nax#2486)", () => {
    const v = parseStoryReviewReply(
      JSON.stringify({
        spec: "fail",
        quality: "approved",
        inspectedFiles: ["prisma/migration.sql"],
        findings: [
          { severity: "important", kind: "spec", issue: "column narrower than the DTO", observed: "note VARCHAR(191)" },
        ],
        cannotVerify: [],
      }),
    );
    expect(v?.findings[0]?.observed).toBe("note VARCHAR(191)");
  });

  test("normalises findings and drops ones without an issue", () => {
    const v = parseStoryReviewReply(
      JSON.stringify({
        spec: "pass",
        quality: "changes",
        findings: [
          {
            severity: "important",
            kind: "quality",
            file: "src/a.ts",
            line: 4,
            issue: "leaks handle",
            suggestion: "close it",
          },
          { severity: "bogus", kind: "bogus", issue: "odd" },
          { severity: "minor", kind: "quality" },
        ],
        cannotVerify: ["perf"],
      }),
    );
    expect(v?.findings).toEqual([
      {
        severity: "important",
        kind: "quality",
        file: "src/a.ts",
        line: 4,
        issue: "leaks handle",
        suggestion: "close it",
      },
      { severity: "important", kind: "quality", issue: "odd" },
    ]);
    expect(v?.cannotVerify).toEqual(["perf"]);
  });

  test("spec fail with no blocking spec finding gets a synthetic one (Review Focus 1)", () => {
    const v = parseStoryReviewReply(
      JSON.stringify({ spec: "fail", quality: "approved", findings: [], cannotVerify: [] }),
    );
    expect(v?.findings).toHaveLength(1);
    expect(v?.findings[0]).toMatchObject({ kind: "spec", severity: "important" });
  });

  test("spec fail with only a minor spec finding still gets the synthetic one", () => {
    const v = parseStoryReviewReply(
      JSON.stringify({
        spec: "fail",
        quality: "approved",
        findings: [{ severity: "minor", kind: "spec", issue: "naming" }],
      }),
    );
    expect(v?.findings.filter((f) => f.severity === "important")).toHaveLength(1);
  });

  test("bad verdict enums -> null", () => {
    expect(parseStoryReviewReply(JSON.stringify({ spec: "ok", quality: "approved", findings: [] }))).toBeNull();
    expect(parseStoryReviewReply("not json")).toBeNull();
  });

  test("keeps inspectedFiles (nax#2488)", () => {
    const v = parseStoryReviewReply(
      JSON.stringify({
        spec: "pass",
        quality: "approved",
        inspectedFiles: ["a.ts", "prisma/schema.prisma"],
        findings: [],
        cannotVerify: [],
      }),
    );
    expect(v?.inspectedFiles).toEqual(["a.ts", "prisma/schema.prisma"]);
  });

  test("missing inspectedFiles -> []", () => {
    const v = parseStoryReviewReply(JSON.stringify({ spec: "pass", quality: "approved", findings: [] }));
    expect(v?.inspectedFiles).toEqual([]);
  });

  test("non-array inspectedFiles -> []", () => {
    const v = parseStoryReviewReply(
      JSON.stringify({ spec: "pass", quality: "approved", inspectedFiles: "a.ts", findings: [] }),
    );
    expect(v?.inspectedFiles).toEqual([]);
  });

  test("non-string inspectedFiles entries are filtered out (nax#2488)", () => {
    const v = parseStoryReviewReply(
      JSON.stringify({
        spec: "pass",
        quality: "approved",
        inspectedFiles: ["a.ts", 3, null, { path: "b.ts" }, "c.ts"],
        findings: [],
      }),
    );
    expect(v?.inspectedFiles).toEqual(["a.ts", "c.ts"]);
  });
});

describe("parseReReviewReply", () => {
  test("missing verdict for an open id stays NOT_ADDRESSED (Review Focus 3)", () => {
    const v = parseReReviewReply(
      JSON.stringify({
        findings: [
          { id: "F1", verdict: "ADDRESSED", note: "fixed" },
          { id: "F9", verdict: "ADDRESSED", note: "unknown id, ignored" },
        ],
        newFindings: [{ severity: "critical", kind: "quality", issue: "broke parse" }],
      }),
      ["F1", "F2"],
    );
    expect(v?.verdicts).toEqual([
      { id: "F1", addressed: true, note: "fixed" },
      { id: "F2", addressed: false, note: "(no verdict returned)" },
    ]);
    expect(v?.newFindings).toEqual([{ severity: "critical", kind: "quality", issue: "broke parse" }]);
  });

  test("no findings array -> null", () => {
    expect(parseReReviewReply(JSON.stringify({ newFindings: [] }), ["F1"])).toBeNull();
  });

  // US-004 (nax#2524): the third verdict, whose residual keeps the finding open under its own id.
  test("a PARTIAL verdict keeps its residual and stays not addressed (AC-1)", () => {
    const v = parseReReviewReply(
      JSON.stringify({
        findings: [{ id: "F1", verdict: "PARTIAL", note: "half done", residual: { issue: "symlinks still bypass" } }],
        newFindings: [],
      }),
      ["F1"],
    );
    expect(v?.verdicts[0]?.addressed).toBe(false);
    expect(v?.verdicts[0]?.residual?.issue).toBe("symlinks still bypass");
  });

  // A usable PARTIAL residual in the same reply, so each test below fails before the parser knows PARTIAL
  // instead of passing vacuously on a parser that never emits a residual at all.
  const CONTROL = { id: "F9", verdict: "PARTIAL", note: "", residual: { issue: "a usable residual" } };

  test("a PARTIAL residual with no issue, or an empty one, carries no residual (AC-2, AC-3)", () => {
    const residuals: unknown[] = [
      undefined,
      {},
      { issue: "" },
      { issue: "   " },
      { issue: 7 },
      "symlinks still bypass",
    ];
    const ids = residuals.map((_, i) => `F${i + 1}`);
    const v = parseReReviewReply(
      JSON.stringify({
        findings: [
          ...residuals.map((residual, i) => ({
            id: ids[i],
            verdict: "PARTIAL",
            note: "",
            ...(residual === undefined ? {} : { residual }),
          })),
          CONTROL,
        ],
        newFindings: [],
      }),
      [...ids, "F9"],
    );
    for (const [i, id] of ids.entries()) {
      const why = `${id} ${JSON.stringify(residuals[i])}`;
      expect(v?.verdicts[i]?.addressed, why).toBe(false);
      expect(v?.verdicts[i], why).not.toHaveProperty("residual");
    }
    expect(v?.verdicts.at(-1)?.residual?.issue).toBe("a usable residual");
  });

  test("a non-PARTIAL verdict that carries a residual drops it (AC-4)", () => {
    const verdicts = ["NOT_ADDRESSED", "ADDRESSED", "partial"];
    const ids = verdicts.map((_, i) => `F${i + 1}`);
    const v = parseReReviewReply(
      JSON.stringify({
        findings: [
          ...verdicts.map((verdict, i) => ({
            id: ids[i],
            verdict,
            note: "",
            residual: { issue: "symlinks still bypass", file: "a.ts", line: 3 },
          })),
          CONTROL,
        ],
        newFindings: [],
      }),
      [...ids, "F9"],
    );
    for (const [i, verdict] of verdicts.entries()) {
      expect(v?.verdicts[i], verdict).not.toHaveProperty("residual");
    }
    expect(v?.verdicts.at(-1)?.residual).toEqual({ issue: "a usable residual" });
  });

  test("a PARTIAL residual keeps only its well-formed fields (AC-15)", () => {
    const v = parseReReviewReply(
      JSON.stringify({
        findings: [
          {
            id: "F1",
            verdict: "PARTIAL",
            note: "",
            residual: { issue: "still bypass", suggestion: "", file: "a.ts", line: 0 },
          },
        ],
        newFindings: [],
      }),
      ["F1"],
    );
    expect(v?.verdicts[0]?.residual).toEqual({ issue: "still bypass", file: "a.ts" });
  });

  test("a missing verdict for a PARTIAL-able id keeps today's note and no residual", () => {
    const v = parseReReviewReply(JSON.stringify({ findings: [], newFindings: [] }), ["F1"]);
    expect(v?.verdicts).toEqual([{ id: "F1", addressed: false, note: "(no verdict returned)" }]);
  });
});

describe("parseBranchReviewReply", () => {
  const base = { spec: "pass", quality: "approved", findings: [], cannotVerify: [] };

  test("keeps the story-review verdict and one triage entry per known minor id", () => {
    const out = parseBranchReviewReply(
      JSON.stringify({
        ...base,
        minorTriage: [
          { id: "M2", decision: "fix-now" },
          { id: "M1", decision: "leave" },
        ],
      }),
      ["M1", "M2", "M3"],
    );
    expect(out?.spec).toBe("pass");
    expect(out?.minorTriage).toEqual([
      { id: "M1", decision: "leave" },
      { id: "M2", decision: "fix-now" },
      { id: "M3", decision: "leave" },
    ]);
  });

  test("missing minorTriage, unknown ids, bad decisions and duplicates -> leave / ignored (P4-R8)", () => {
    const out = parseBranchReviewReply(
      JSON.stringify({
        ...base,
        minorTriage: [
          { id: "M9", decision: "fix-now" },
          { id: "M1", decision: "now!" },
          { id: "M1", decision: "fix-now" },
          { id: "M1", decision: "leave" },
        ],
      }),
      ["M1"],
    );
    expect(out?.minorTriage).toEqual([{ id: "M1", decision: "fix-now" }]);
    expect(parseBranchReviewReply(JSON.stringify(base), ["M1"])?.minorTriage).toEqual([
      { id: "M1", decision: "leave" },
    ]);
  });

  test("an invalid review shape is null", () => {
    expect(parseBranchReviewReply("nope", ["M1"])).toBeNull();
    expect(parseBranchReviewReply(JSON.stringify({ spec: "maybe" }), [])).toBeNull();
  });
});
