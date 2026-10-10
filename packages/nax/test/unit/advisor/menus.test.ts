import { describe, expect, test } from "bun:test";
import type { AdvisorReply, MenuFacts } from "@/advisor";
import { buildMenu, forcedConfirm, toAction } from "@/advisor";

const types = (facts: MenuFacts) => buildMenu(facts).map((o) => o.type);

const reply = (over: Partial<AdvisorReply> = {}): AdvisorReply => ({
  optionId: "A",
  rationale: "r",
  confidence: "high",
  reversible: true,
  needsHumanConfirm: false,
  ...over,
});

describe("buildMenu", () => {
  test("finish-judgment: supersede of an AC only when acceptance is off for the story", () => {
    const base = { kind: "finish-judgment" as const, citesAc: { storyId: "US-1", acId: "AC-3" } };
    expect(types({ ...base, acceptanceEnabledForStory: true })).toEqual(["fix", "waive", "hold"]);
    expect(types({ ...base, acceptanceEnabledForStory: false })).toEqual(["fix", "waive", "supersede", "hold"]);
  });

  test("finish-judgment: a spec-section supersede is offered regardless of acceptance", () => {
    expect(types({ kind: "finish-judgment", citesSpecSection: "Design", acceptanceEnabledForStory: true })).toEqual([
      "fix",
      "waive",
      "supersede",
      "hold",
    ]);
  });

  test("finish-judgment: no citation, no supersede", () => {
    expect(types({ kind: "finish-judgment", acceptanceEnabledForStory: false })).toEqual(["fix", "waive", "hold"]);
  });

  test("give-up: retarget to test only in three-session when a source fixer gave up", () => {
    const facts: MenuFacts = {
      kind: "fix-cycle-give-up",
      isThreeSession: true,
      gaveUpTarget: "source",
      retryAvailable: true,
      retargetAvailable: true,
      budgetLeft: true,
      acceptanceEnabledForStory: true,
    };
    const menu = buildMenu(facts);
    expect(menu.map((o) => o.type)).toEqual(["retry", "retarget", "waive", "escalate-tier", "defer"]);
    expect(menu.find((o) => o.type === "retarget")?.fixed).toEqual({ to: "test" });
    expect(types({ ...facts, isThreeSession: false })).toEqual(["retry", "waive", "escalate-tier", "defer"]);
  });

  test("give-up: a test fixer that gave up may retarget to source", () => {
    const menu = buildMenu({
      kind: "fix-cycle-give-up",
      isThreeSession: true,
      gaveUpTarget: "test",
      retryAvailable: false,
      retargetAvailable: true,
      budgetLeft: true,
      acceptanceEnabledForStory: true,
    });
    expect(menu.map((o) => o.type)).toEqual(["retarget", "waive", "escalate-tier", "defer"]);
    expect(menu[0]?.fixed).toEqual({ to: "source" });
  });

  test("give-up: exhausted budget leaves only escalate-tier and defer", () => {
    expect(
      types({
        kind: "fix-cycle-give-up",
        isThreeSession: true,
        gaveUpTarget: "source",
        retryAvailable: true,
        retargetAvailable: true,
        budgetLeft: false,
        citesAc: { storyId: "US-1", acId: "AC-1" },
        acceptanceEnabledForStory: false,
      }),
    ).toEqual(["escalate-tier", "defer"]);
  });

  test("uncategorised: retry-as-lite only for three-session not already lite", () => {
    expect(types({ kind: "uncategorised-failure", isThreeSession: true, isLite: false })).toEqual([
      "retry-as-lite",
      "escalate-tier",
      "defer",
    ]);
    expect(types({ kind: "uncategorised-failure", isThreeSession: true, isLite: true })).toEqual([
      "escalate-tier",
      "defer",
    ]);
  });

  test("approval: approve only after complete reviews and green gates; re-review once", () => {
    const ok = {
      kind: "finish-approval" as const,
      allPhasesComplete: true,
      gatesGreen: true,
      reReviewUsed: false,
      reReviewPhase: "quality" as const,
    };
    expect(types(ok)).toEqual(["approve", "re-review", "hold"]);
    expect(types({ ...ok, allPhasesComplete: false })).toEqual(["re-review", "hold"]);
    expect(types({ ...ok, gatesGreen: false })).toEqual(["re-review", "hold"]);
    expect(types({ ...ok, reReviewUsed: true })).toEqual(["approve", "hold"]);
  });

  test("option ids are A, B, C… in order", () => {
    expect(buildMenu({ kind: "uncategorised-failure", isThreeSession: false, isLite: false }).map((o) => o.id)).toEqual(
      ["A", "B"],
    );
  });
});

describe("toAction", () => {
  test("merges menu-fixed parameters with the reply's text", () => {
    const [opt] = buildMenu({
      kind: "fix-cycle-give-up",
      isThreeSession: true,
      gaveUpTarget: "test",
      retryAvailable: false,
      retargetAvailable: true,
      budgetLeft: true,
      acceptanceEnabledForStory: true,
    });
    expect(opt && toAction(opt, reply({ instruction: "edit src" }))).toEqual({
      type: "retarget",
      to: "source",
      instruction: "edit src",
    });
  });
});

describe("forcedConfirm", () => {
  test("low confidence, irreversible, supersede/defer/hold, and blocking waives are always flagged", () => {
    expect(forcedConfirm({ type: "fix", instruction: "x" }, reply({ confidence: "low" }))).toBe(true);
    expect(forcedConfirm({ type: "fix", instruction: "x" }, reply({ reversible: false }))).toBe(true);
    expect(forcedConfirm({ type: "hold", reason: "x" }, reply())).toBe(true);
    expect(forcedConfirm({ type: "waive", reason: "x" }, reply(), "HIGH")).toBe(true);
    expect(forcedConfirm({ type: "waive", reason: "x" }, reply(), "error")).toBe(true);
    expect(forcedConfirm({ type: "waive", reason: "x" }, reply(), "LOW")).toBe(false);
    expect(forcedConfirm({ type: "fix", instruction: "x" }, reply({ needsHumanConfirm: true }))).toBe(true);
    expect(forcedConfirm({ type: "fix", instruction: "x" }, reply())).toBe(false);
  });
});
