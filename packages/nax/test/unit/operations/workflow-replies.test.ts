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

  // US-011: the branch parser synthesizes nothing — a mismatch is metadata, never a finding.
  test("spec failure without findings keeps the mismatch and invents no draft", () => {
    const raw = JSON.stringify({ spec: "fail", quality: "approved", findings: [] });
    const v = parseStoryReviewReply(raw);
    expect(v?.findings).toEqual([]);
    expect(v?.mismatch).toEqual(["spec"]);
    const branch = parseBranchReviewReply(raw, []);
    expect(branch?.findings).toEqual([]);
    expect(branch?.mismatch).toEqual(["spec"]);
  });

  test("minor spec finding remains alone; branch adds no spec draft", () => {
    const raw = JSON.stringify({
      spec: "fail",
      quality: "approved",
      findings: [{ severity: "minor", kind: "spec", issue: "naming" }],
    });
    const v = parseStoryReviewReply(raw);
    expect(v?.mismatch).toEqual(["spec"]);
    expect(v?.findings).toHaveLength(1);
    expect(parseBranchReviewReply(raw, [])?.findings).toEqual([{ severity: "minor", kind: "spec", issue: "naming" }]);
  });

  test("quality changes without blocking findings keeps the mismatch and adds no draft", () => {
    for (const findings of [
      [],
      [{ severity: "minor", kind: "quality", issue: "naming" }],
      [{ severity: "important", kind: "quality", description: "race" }],
    ]) {
      const raw = JSON.stringify({ spec: "pass", quality: "changes", findings });
      const v = parseStoryReviewReply(raw);
      expect(v?.mismatch).toEqual(["quality"]);
      expect(v?.findings.filter((f) => f.severity !== "minor")).toEqual([]);
      expect(parseBranchReviewReply(raw, [])?.findings.filter((f) => f.severity !== "minor")).toEqual([]);
    }
  });

  test("both mismatches are ordered, and the branch adds no draft for either", () => {
    const raw = JSON.stringify({ spec: "fail", quality: "changes", findings: [] });
    expect(parseStoryReviewReply(raw)?.mismatch).toEqual(["spec", "quality"]);
    const branch = parseBranchReviewReply(raw, []);
    expect(branch?.findings).toEqual([]);
    expect(branch?.mismatch).toEqual(["spec", "quality"]);
  });

  test.each([
    { spec: "fail", quality: "approved", expected: ["spec"] },
    { spec: "pass", quality: "changes", expected: ["quality"] },
    { spec: "fail", quality: "changes", expected: ["spec", "quality"] },
  ])("important spec finding clears mismatch for $spec / $quality", ({ spec, quality, expected }) => {
    const verdict = { spec, quality, findings: [] };
    const withoutFinding = parseStoryReviewReply(JSON.stringify(verdict));
    expect(withoutFinding?.mismatch).toEqual(expected);
    const withFinding = parseStoryReviewReply(
      JSON.stringify({ ...verdict, findings: [{ severity: "important", kind: "spec", issue: "broken AC" }] }),
    );
    expect(withFinding).not.toBeNull();
    expect(withFinding?.findings).toEqual([{ severity: "important", kind: "spec", issue: "broken AC" }]);
    expect(withFinding).not.toHaveProperty("mismatch");
  });

  test("quality changes with a blocking finding, or quality approved, adds nothing", () => {
    const blocking = parseStoryReviewReply(
      JSON.stringify({
        spec: "pass",
        quality: "changes",
        findings: [{ severity: "important", kind: "quality", issue: "leaks handle" }],
      }),
    );
    expect(blocking?.findings).toHaveLength(1);
    const approved = parseStoryReviewReply(JSON.stringify({ spec: "pass", quality: "approved", findings: [] }));
    expect(approved?.findings).toEqual([]);
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

  // US-002: `narrower` marks a residual that is the same problem in a smaller form, which the story
  // loop routes to the residual advisor instead of spending another fix round on it.
  test("a PARTIAL entry with narrower: true carries the flag (US-002 AC-1)", () => {
    const v = parseReReviewReply(
      JSON.stringify({
        findings: [{ id: "F1", verdict: "PARTIAL", narrower: true, residual: { issue: "x" } }],
        newFindings: [],
      }),
      ["F1"],
    );
    expect(v?.verdicts[0]).toEqual({
      id: "F1",
      addressed: false,
      note: "",
      residual: { issue: "x" },
      narrower: true,
    });
  });

  test("a PARTIAL entry with no narrower field carries no flag (US-002 AC-2)", () => {
    const v = parseReReviewReply(
      JSON.stringify({
        findings: [{ id: "F1", verdict: "PARTIAL", residual: { issue: "x" } }],
        newFindings: [],
      }),
      ["F1"],
    );
    expect(v?.verdicts[0]?.residual?.issue).toBe("x");
    expect(v?.verdicts[0]).not.toHaveProperty("narrower");
  });

  test("an ADDRESSED entry with narrower: true drops the flag (US-002 AC-3)", () => {
    const v = parseReReviewReply(
      JSON.stringify({
        findings: [{ id: "F1", verdict: "ADDRESSED", narrower: true, note: "" }],
        newFindings: [],
      }),
      ["F1"],
    );
    expect(v?.verdicts[0]?.addressed).toBe(true);
    expect(v?.verdicts[0]).not.toHaveProperty("narrower");
  });

  test("a NOT_ADDRESSED entry with narrower: true drops the flag (US-002 AC-4)", () => {
    const v = parseReReviewReply(
      JSON.stringify({
        findings: [{ id: "F1", verdict: "NOT_ADDRESSED", narrower: true, note: "" }],
        newFindings: [],
      }),
      ["F1"],
    );
    expect(v?.verdicts[0]?.addressed).toBe(false);
    expect(v?.verdicts[0]).not.toHaveProperty("narrower");
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

/**
 * US-011: `parseBranchReviewReply` is a lenient shape parser. It keeps the reviewer's real findings and
 * the story parser's mismatch metadata, and never injects a draft to justify a verdict.
 */
describe("parseBranchReviewReply mismatch (US-011)", () => {
  const reply = (over: Record<string, unknown>): string =>
    JSON.stringify({ spec: "pass", quality: "approved", findings: [], cannotVerify: [], ...over });

  test("AC-1 returns the spec mismatch for a fail verdict with no critical or important spec finding", () => {
    expect(parseBranchReviewReply(reply({ spec: "fail" }), [])?.mismatch).toEqual(["spec"]);
  });

  test("AC-2 preserves only the real drafts when the reply has no findings", () => {
    const out = parseBranchReviewReply(reply({ spec: "fail", quality: "changes" }), []);
    expect(out?.findings).toEqual([]);
  });

  test("AC-3 preserves only the real drafts when findings were dropped as invalid", () => {
    const out = parseBranchReviewReply(
      reply({
        spec: "fail",
        quality: "changes",
        findings: [{ severity: "important", kind: "spec" }, { severity: "bogus", kind: "bogus" }, "not a finding"],
      }),
      [],
    );
    expect(out?.findings).toEqual([]);
    expect(out?.mismatch).toEqual(["spec", "quality"]);
  });

  test("AC-4 preserves only the real drafts when findings are minor-only", () => {
    const minor = { severity: "minor" as const, kind: "spec" as const, issue: "naming" };
    const out = parseBranchReviewReply(reply({ spec: "fail", findings: [minor] }), []);
    expect(out?.findings).toEqual([minor]);
    expect(out?.mismatch).toEqual(["spec"]);
  });

  test("AC-5 returns the quality mismatch for a changes verdict with no critical or important finding", () => {
    expect(parseBranchReviewReply(reply({ quality: "changes" }), [])?.mismatch).toEqual(["quality"]);
  });

  test("AC-6 adds no important quality draft for that case", () => {
    const out = parseBranchReviewReply(reply({ quality: "changes" }), []);
    expect(out?.findings).toEqual([]);
    expect(out?.findings.some((f) => f.kind === "quality" && f.severity === "important")).toBe(false);
  });

  test("AC-7 reports both mismatch kinds once in spec then quality order when neither verdict has its evidence", () => {
    const out = parseBranchReviewReply(reply({ spec: "fail", quality: "changes" }), []);
    expect(out?.mismatch).toEqual(["spec", "quality"]);
    expect(out?.findings).toEqual([]);
  });

  test("AC-8 preserves concrete blocking findings for a consistent reply", () => {
    const blocking = { severity: "important" as const, kind: "quality" as const, issue: "leaks a handle" };
    const out = parseBranchReviewReply(reply({ quality: "changes", findings: [blocking] }), []);
    expect(out?.findings).toEqual([blocking]);
    expect(out).not.toHaveProperty("mismatch");
  });

  test("AC-9 preserves the known-minor triage normalization for a consistent reply", () => {
    const out = parseBranchReviewReply(
      reply({
        minorTriage: [
          { id: "M9", decision: "fix-now" },
          { id: "M1", decision: "now!" },
          { id: "M1", decision: "fix-now" },
        ],
      }),
      ["M1", "M2"],
    );
    expect(out?.minorTriage).toEqual([
      { id: "M1", decision: "fix-now" },
      { id: "M2", decision: "leave" },
    ]);
    expect(out).not.toHaveProperty("mismatch");
  });

  test("AC-10 still returns null for a malformed verdict shape", () => {
    expect(parseBranchReviewReply(reply({ spec: "maybe" }), [])).toBeNull();
    expect(parseBranchReviewReply(reply({ quality: "ok" }), [])).toBeNull();
    expect(parseBranchReviewReply("not json", [])).toBeNull();
  });
});
