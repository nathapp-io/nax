import { describe, expect, test } from "bun:test";
import type { AdvisorReply } from "@/advisor";
import { buildMenu, forcedConfirm, PREFLIGHT_OPTION_IDS, REQUIRED_TEXT_FIELD, toAction } from "@/advisor";

const reply = (over: Partial<AdvisorReply> = {}): AdvisorReply => ({
  optionId: "A",
  rationale: "r",
  confidence: "high",
  reversible: true,
  needsHumanConfirm: false,
  ...over,
});

describe("implementer-question menu", () => {
  test("answer or hold", () => {
    const menu = buildMenu({ kind: "implementer-question" });
    expect(menu.map((o) => [o.id, o.type])).toEqual([
      ["A", "answer"],
      ["B", "hold"],
    ]);
  });

  test("answer takes its text from instruction", () => {
    const [answer] = buildMenu({ kind: "implementer-question" });
    if (!answer) throw new Error("no answer option");
    expect(REQUIRED_TEXT_FIELD.answer).toBe("instruction");
    expect(toAction(answer, reply({ instruction: "Use the tenant id from the JWT." }))).toEqual({
      type: "answer",
      text: "Use the tenant id from the JWT.",
    });
  });
});

describe("residual menu", () => {
  test("carry appears only with dependents, with toStories fixed by the menu (P3-R1)", () => {
    const withDeps = buildMenu({ kind: "residual", dependents: ["US-004", "US-005"] });
    expect(withDeps.map((o) => o.type)).toEqual(["waive", "defer", "carry", "hold"]);
    const carry = withDeps.find((o) => o.type === "carry");
    expect(carry?.fixed?.toStories).toEqual(["US-004", "US-005"]);
    expect(carry?.label).toContain("US-004, US-005");
    expect(buildMenu({ kind: "residual", dependents: [] }).map((o) => o.type)).toEqual(["waive", "defer", "hold"]);
  });

  test("carry action carries the instruction and the menu's stories", () => {
    const carry = buildMenu({ kind: "residual", dependents: ["US-004"] }).find((o) => o.type === "carry");
    if (!carry) throw new Error("no carry option");
    expect(REQUIRED_TEXT_FIELD.carry).toBe("instruction");
    expect(toAction(carry, reply({ optionId: carry.id, instruction: "Keep the lock order." }))).toEqual({
      type: "carry",
      instruction: "Keep the lock order.",
      toStories: ["US-004"],
    });
  });

  test("carry is not force-flagged; hold still is", () => {
    const carry = { type: "carry" as const, instruction: "x", toStories: ["US-4"] };
    expect(forcedConfirm(carry, reply())).toBe(false);
    expect(forcedConfirm({ type: "hold", reason: "x" }, reply())).toBe(true);
  });
});

describe("preflight menu", () => {
  test("fixed ids A-D; options missing a reference are omitted without shifting ids", () => {
    const both = buildMenu({ kind: "preflight", acRef: { storyId: "US-2", acId: "AC-3" }, specSection: "4.1" });
    expect(both.map((o) => [o.id, o.type])).toEqual([
      [PREFLIGHT_OPTION_IDS.followAc, "supersede"],
      [PREFLIGHT_OPTION_IDS.followSpec, "supersede"],
      [PREFLIGHT_OPTION_IDS.reconcile, "supersede"],
      [PREFLIGHT_OPTION_IDS.flag, "hold"],
    ]);
    expect(both[0]?.fixed?.target).toEqual({ kind: "spec", section: "4.1" });
    expect(both[1]?.fixed?.target).toEqual({ kind: "ac", storyId: "US-2", acId: "AC-3" });

    const specOnly = buildMenu({ kind: "preflight", specSection: "4.1" });
    expect(specOnly.map((o) => o.id)).toEqual(["A", "D"]);
    const acOnly = buildMenu({ kind: "preflight", acRef: { storyId: "US-2", acId: "AC-3" } });
    expect(acOnly.map((o) => o.id)).toEqual(["B", "C", "D"]);
  });
});

describe("pipeline menus unchanged", () => {
  test("finish-approval still approve / re-review / hold", () => {
    const menu = buildMenu({
      kind: "finish-approval",
      allPhasesComplete: true,
      gatesGreen: true,
      reReviewUsed: false,
      reReviewPhase: "quality",
    });
    expect(menu.map((o) => [o.id, o.type])).toEqual([
      ["A", "approve"],
      ["B", "re-review"],
      ["C", "hold"],
    ]);
  });
});
