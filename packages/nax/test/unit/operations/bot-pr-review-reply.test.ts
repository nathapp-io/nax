import { describe, expect, test } from "bun:test";
import { assertDefined } from "@test/helpers";
import type { PrEarlierVerdict, PrReviewVerdict, PrTriageVerdict } from "@/operations";
import { missingTriage, parseBranchReviewReply, parsePrReviewReply, toFindingDraft } from "@/operations";

const base = { intent: "n/a", quality: "approved" } satisfies Pick<PrReviewVerdict, "intent" | "quality">;
const triage = { id: "T1", decision: "agree", reason: "needed" } satisfies PrTriageVerdict;
const parse = (extra: Record<string, unknown> = {}) =>
  parsePrReviewReply(JSON.stringify({ ...base, ...extra }), ["T1", "T2"], ["C1"]);

describe("parsePrReviewReply", () => {
  const earlier = { id: "E1", status: "fixed", reason: "done" } satisfies PrEarlierVerdict;
  const withExtra = (value: Record<string, unknown>, extra = { earlierIds: ["E1"], decisionIds: ["D-1"] }) =>
    parsePrReviewReply(JSON.stringify({ ...base, ...value }), [], [], extra);

  test("US-006 AC-1 keeps an allowlisted earlier verdict and trims its reason", () => {
    expect(withExtra({ earlier: [{ ...earlier, reason: "  done  " }] })?.earlier).toEqual([earlier]);
  });
  test.each([
    ["AC-2", { ...earlier, id: "unknown" }],
    ["AC-3", { ...earlier, status: "stale" }],
    ["AC-4", { ...earlier, reason: " \n " }],
    ["non-string reason", { ...earlier, reason: 42 }],
    ["non-string id", { ...earlier, id: 42 }],
    ["null entry", null],
  ])("US-006 %s drops invalid earlier entries", (_ac, entry) => {
    expect(withExtra({ earlier: [entry] })?.earlier).toEqual([]);
  });
  test("US-006 AC-5 keeps only the first valid earlier entry per id", () => {
    expect(
      withExtra({ earlier: [{ ...earlier, status: "stale" }, earlier, { ...earlier, status: "open" }] })?.earlier,
    ).toEqual([earlier]);
  });
  test.each(["open", "fixed", "withdrawn"])("keeps earlier status %s", (status) => {
    expect(withExtra({ earlier: [{ ...earlier, status }] })?.earlier).toEqual([{ ...earlier, status }]);
  });
  test("US-006 AC-6 keeps an allowlisted decision reference", () => {
    expect(withExtra({ findings: [{ issue: "bug", decision: "D-1" }] })?.findings[0]).toHaveProperty("decision", "D-1");
  });
  test.each(["D-9", 42, null])("US-006 AC-7 keeps the finding without invalid decision %j", (decision) => {
    const result = withExtra({ findings: [{ issue: "bug", decision }] });
    expect(result?.findings).toHaveLength(1);
    expect(result?.findings[0]).toMatchObject({ issue: "bug" });
    expect(result?.findings[0]).not.toHaveProperty("decision");
  });
  test("US-006 AC-8 three arguments preserve thread/comment triage without accepting earlier ids", () => {
    expect(parse({ earlier: [earlier], threads: [triage], comments: [{ ...triage, id: "C1" }] })).toEqual({
      ...base,
      earlier: [],
      findings: [],
      threads: [triage],
      comments: [{ ...triage, id: "C1" }],
      cannotVerify: [],
      inspectedFiles: [],
    });
  });
  test("AC-1 accepts n/a and defaults optional lists", () => {
    expect(parse()).toEqual({
      ...base,
      findings: [],
      earlier: [],
      threads: [],
      comments: [],
      cannotVerify: [],
      inspectedFiles: [],
    });
  });
  test.each([
    ["AC-2", { intent: "maybe" }],
    ["AC-3", { quality: "ok" }],
  ])("%s rejects invalid verdict enums", (_ac, extra) => expect(parse(extra)).toBeNull());
  test.each(["no JSON here", "[]", "null", "42"])("AC-4 rejects non-object %s", (output) => {
    expect(parsePrReviewReply(output, [], [])).toBeNull();
  });
  test("AC-5 defaults severity and shares finding sanitation", () => {
    const finding = { issue: "bug", file: "a.ts", line: 2, observed: "broken", suggestion: "fix" };
    const draft = toFindingDraft(finding);
    assertDefined(draft, "sanitized finding");
    expect(parse({ findings: [null, {}, finding] })?.findings).toEqual([draft]);
    expect(parse({ findings: [finding] })?.findings[0]?.severity).toBe("important");
  });
  test("AC-6 drops acId entirely", () => {
    const finding = parse({ findings: [{ issue: "bug", acId: "AC-1" }] })?.findings[0];
    expect(finding).toMatchObject({ issue: "bug" });
    expect(finding).not.toHaveProperty("acId");
  });
  test.each([
    ["AC-7", { ...triage, id: "unknown" }],
    ["AC-8", { ...triage, decision: "maybe" }],
    ["AC-9", { ...triage, reason: " \n " }],
  ])("%s drops invalid thread entries", (_ac, entry) => expect(parse({ threads: [entry] })?.threads).toEqual([]));
  test("AC-10 keeps the first repeated id", () => {
    expect(parse({ threads: [triage, { ...triage, decision: "handled", reason: "later" }] })?.threads).toEqual([
      triage,
    ]);
  });
  test("AC-11 drops unknown comments and sanitizes known comments", () => {
    expect(parse({ comments: [triage, { ...triage, id: "C1", reason: "  done  " }] })?.comments).toEqual([
      { ...triage, id: "C1", reason: "done" },
    ]);
  });
  test("extracts fenced JSON and filters non-string list entries", () => {
    const output = `Here is the review:\n\`\`\`json\n${JSON.stringify({ ...base, cannotVerify: [1, "tests"], inspectedFiles: [null, "a.ts"] })}\n\`\`\``;
    expect(parsePrReviewReply(output, [], [])).toMatchObject({ cannotVerify: ["tests"], inspectedFiles: ["a.ts"] });
  });
});

describe("missingTriage", () => {
  test("US-006 AC-9 reports only unanswered earlier ids", () => {
    const verdict = {
      ...base,
      findings: [],
      threads: [],
      comments: [],
      cannotVerify: [],
      inspectedFiles: [],
      earlier: [{ id: "E1", status: "fixed" as const, reason: "done" }],
    };
    expect(missingTriage(verdict, [], [], ["E1", "E2"])).toEqual(["E2"]);
  });
  test("AC-12 returns missing threads first, in input order", () => {
    const verdict = parse({ threads: [{ ...triage, id: "T2" }] });
    if (!verdict) throw new Error("expected verdict");
    expect(missingTriage(verdict, ["T1", "T2"], ["C1"])).toEqual(["T1", "C1"]);
  });
});

describe("toFindingDraft", () => {
  test("AC-23 preserves workflow finding acId", () => {
    const finding = { issue: "bug", acId: "AC-1" };
    expect(toFindingDraft(finding)).toHaveProperty("acId", "AC-1");
    expect(
      parseBranchReviewReply(JSON.stringify({ spec: "pass", quality: "changes", findings: [finding] }), [])
        ?.findings[0],
    ).toHaveProperty("acId", "AC-1");
  });
});
