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
    expect(parse({ findings: [null, {}, finding] })?.findings).toEqual([{ ...draft, trigger: "normal" }]);
    expect(parse({ findings: [finding] })?.findings[0]?.severity).toBe("important");
  });
  test("US-001 AC-3 keeps an adversarial trigger and trims its evidence", () => {
    const finding = { issue: "bug", trigger: "adversarial", triggerEvidence: "  forged mtime on the claim file  " };
    expect(parse({ findings: [finding] })?.findings[0]).toMatchObject({
      trigger: "adversarial",
      triggerEvidence: "forged mtime on the claim file",
    });
  });
  test("US-001 AC-4 reads a missing trigger as normal and adds no evidence key", () => {
    const finding = parse({ findings: [{ issue: "bug" }] })?.findings[0];
    expect(finding).toHaveProperty("trigger", "normal");
    expect(finding).not.toHaveProperty("triggerEvidence");
  });
  test("US-001 AC-5 reads an unknown trigger class as normal", () => {
    expect(parse({ findings: [{ issue: "bug", trigger: "race" }] })?.findings[0]).toHaveProperty("trigger", "normal");
  });
  test.each(["", "   \n", 42] as const)("US-001 AC-6 drops evidence %j", (triggerEvidence) => {
    const kept = parse({ findings: [{ issue: "bug", triggerEvidence: "forged mtime" }] })?.findings[0];
    expect(kept).toHaveProperty("triggerEvidence", "forged mtime");
    expect(parse({ findings: [{ issue: "bug", triggerEvidence }] })?.findings[0]).not.toHaveProperty("triggerEvidence");
  });
  test("US-001 AC-7 caps evidence at 300 characters", () => {
    const parsed = parse({ findings: [{ issue: "bug", triggerEvidence: "z".repeat(500) }] })?.findings[0];
    expect(parsed?.triggerEvidence).toBe("z".repeat(300));
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

describe("parsePrReviewReply finding origin (US-002)", () => {
  /** No prompt context at all: the parser keeps an origin a review was never asked for. */
  const findingOf = (extra: Record<string, unknown>) =>
    parsePrReviewReply(JSON.stringify({ ...base, findings: [{ issue: "bug", ...extra }] }), [], [])?.findings[0];

  test("AC-11 reads fix-gap and trims its evidence on a review asked for no origin", () => {
    const finding = findingOf({ origin: "fix-gap", originEvidence: "  added by push 1  " });
    expect(finding).toMatchObject({ origin: "fix-gap", originEvidence: "added by push 1" });
  });
  test("AC-12 reads pr as a stated origin", () => {
    expect(findingOf({ origin: "pr" })).toHaveProperty("origin", "pr");
  });
  test("AC-13 leaves a finding with no origin carrying neither field", () => {
    const finding = findingOf({});
    expect(finding).not.toHaveProperty("origin");
    expect(finding).not.toHaveProperty("originEvidence");
    // The same finding does carry the field once the reply states one: absence above is the omission.
    expect(findingOf({ origin: "pr", originEvidence: "own line" })).toHaveProperty("origin", "pr");
  });
  test("AC-14 drops an unknown origin value", () => {
    const finding = findingOf({ origin: "regression", originEvidence: "not a push" });
    expect(finding).not.toHaveProperty("origin");
    expect(finding).not.toHaveProperty("originEvidence");
    expect(findingOf({ origin: "fix-regression", originEvidence: "not a push" })).toHaveProperty(
      "origin",
      "fix-regression",
    );
  });
  test("AC-15 caps origin evidence at 300 characters", () => {
    expect(findingOf({ origin: "fix-gap", originEvidence: "z".repeat(400) })?.originEvidence).toBe("z".repeat(300));
  });
  test("AC-16 drops whitespace-only origin evidence but keeps the origin", () => {
    const finding = findingOf({ origin: "fix-gap", originEvidence: "   " });
    expect(finding).toHaveProperty("origin", "fix-gap");
    expect(finding).not.toHaveProperty("originEvidence");
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
