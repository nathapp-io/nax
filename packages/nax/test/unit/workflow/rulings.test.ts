import { describe, expect, test } from "bun:test";
import type { AdviceDecision } from "@/advisor";
import { rulingsForStory } from "@/workflow/rulings";

const d = (over: Partial<AdviceDecision>): AdviceDecision => ({
  id: "D-1",
  questionId: "Q",
  kind: "preflight",
  chosenOptionId: "B",
  action: { type: "hold", reason: "r" },
  rationale: "x",
  confidence: "high",
  reversible: true,
  needsHumanConfirm: false,
  decidedAt: "t",
  model: "m",
  memoryMode: "stateless",
  auditRef: "a",
  ...over,
});

describe("rulingsForStory", () => {
  test("pre-flight supersede/hold and carries that apply to the story, in ledger order", () => {
    const decisions = [
      d({
        id: "D-1",
        appliesTo: ["US-2"],
        action: { type: "supersede", target: { kind: "ac", storyId: "US-2", acId: "AC-3" }, newText: "14 days" },
      }),
      d({ id: "D-2", appliesTo: ["US-3"], action: { type: "hold", reason: "keep 30d" } }),
      d({ id: "D-3", appliesTo: ["US-2"], action: { type: "hold", reason: "use UTC" } }),
      d({
        id: "D-4",
        kind: "residual",
        storyId: "US-1",
        appliesTo: ["US-2"],
        action: { type: "carry", instruction: "Keep lock order", toStories: ["US-2"] },
      }),
      d({ id: "D-5", kind: "residual", storyId: "US-1", action: { type: "waive", reason: "x" } }),
    ];
    expect(rulingsForStory(decisions, "US-2")).toEqual([
      "Pre-flight D-1: US-2 AC-3 now reads: 14 days",
      "Pre-flight D-3: flagged for a human; run under this default: use UTC",
      "Carried from US-1 (D-4): Keep lock order",
    ]);
    expect(rulingsForStory(decisions, "US-9")).toEqual([]);
  });
});

/**
 * US-001: a mid-loop advisor answer or residual ruling is a settled ruling too, so the brief a
 * reviewer reads carries it. A `hold` is not: a human still decides.
 */
describe("rulingsForStory — the story's own settled rulings (US-001)", () => {
  const answer = (over: Partial<AdviceDecision> = {}): AdviceDecision =>
    d({
      id: "D-2",
      kind: "implementer-question",
      storyId: "US-1",
      chosenOptionId: "A",
      action: { type: "answer", text: "Keep the lstat walk" },
      ...over,
    });

  test("AC-1: an implementer-question answer for the story renders as an advisor answer", () => {
    expect(rulingsForStory([answer()], "US-1")).toContain("Advisor answer D-2: Keep the lstat walk");
  });

  test("AC-2: a residual waive for the story renders with its ruling type and reason", () => {
    const decisions = [
      d({
        id: "D-3",
        kind: "residual",
        storyId: "US-1",
        action: { type: "waive", reason: "Already ruled in D-2" },
      }),
    ];
    expect(rulingsForStory(decisions, "US-1")).toContain("Residual ruling D-3 (waive): Already ruled in D-2");
  });

  test("AC-2: a residual defer renders with its ruling type and reason", () => {
    const decisions = [
      d({ id: "D-5", kind: "residual", storyId: "US-1", action: { type: "defer", reason: "next feature" } }),
    ];
    expect(rulingsForStory(decisions, "US-1")).toContain("Residual ruling D-5 (defer): next feature");
  });

  test("AC-3: a residual hold is not a settled ruling, so it is left out", () => {
    const decisions = [
      d({ id: "D-4", kind: "residual", storyId: "US-1", action: { type: "hold", reason: "needs a human" } }),
    ];
    const lines = rulingsForStory(decisions, "US-1");
    expect(lines.filter((line) => line.includes("D-4"))).toEqual([]);
    expect(lines).toEqual([]);
  });

  test("AC-4: another story's answer stays out of this story's list", () => {
    const decisions = [answer({ storyId: "US-2", action: { type: "answer", text: "Use the other walk" } })];
    expect(rulingsForStory(decisions, "US-1").join("\n")).not.toContain("Use the other walk");
  });

  test("AC-5: pre-flight and settled lines keep ledger order", () => {
    const decisions = [
      d({ id: "D-1", kind: "preflight", appliesTo: ["US-1"], action: { type: "hold", reason: "use UTC" } }),
      answer(),
    ];
    const lines = rulingsForStory(decisions, "US-1");
    expect(lines[0]).toBe("Pre-flight D-1: flagged for a human; run under this default: use UTC");
    expect(lines[1]).toBe("Advisor answer D-2: Keep the lstat walk");
  });
});
