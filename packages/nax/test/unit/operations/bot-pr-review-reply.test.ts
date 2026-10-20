import { describe, expect, test } from "bun:test";
import { assertDefined } from "@test/helpers";
import type { PrReviewVerdict, PrTriageVerdict } from "@/operations";
import { missingTriage, parseBranchReviewReply, parsePrReviewReply, toFindingDraft } from "@/operations";

const base = { intent: "n/a", quality: "approved" } satisfies Pick<PrReviewVerdict, "intent" | "quality">;
const triage = { id: "T1", decision: "agree", reason: "needed" } satisfies PrTriageVerdict;
const parse = (extra: Record<string, unknown> = {}) =>
  parsePrReviewReply(JSON.stringify({ ...base, ...extra }), ["T1", "T2"], ["C1"]);

describe("parsePrReviewReply", () => {
  test("AC-1 accepts n/a and defaults optional lists", () => {
    expect(parse()).toEqual({ ...base, findings: [], threads: [], comments: [], cannotVerify: [], inspectedFiles: [] });
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
