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
