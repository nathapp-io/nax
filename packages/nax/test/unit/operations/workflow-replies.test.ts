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
