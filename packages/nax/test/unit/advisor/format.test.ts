import { describe, expect, test } from "bun:test";
import type { AdviceDecision } from "@/advisor";
import { formatDecisionsForPrompt } from "@/advisor";

const d = (id: string, action: AdviceDecision["action"], over: Partial<AdviceDecision> = {}): AdviceDecision => ({
  id,
  questionId: "Q",
  kind: "finish-judgment",
  chosenOptionId: "A",
  action,
  rationale: `why ${id}`,
  confidence: "high",
  reversible: true,
  needsHumanConfirm: false,
  decidedAt: "t",
  model: "m",
  memoryMode: "stateless",
  auditRef: "a",
  ...over,
});

describe("formatDecisionsForPrompt", () => {
  test("lists only waive and supersede decisions, so reviewers stop re-raising them", () => {
    const text = formatDecisionsForPrompt([
      d("D-1", { type: "fix", instruction: "x" }),
      d("D-2", { type: "waive", reason: "US-5 owns it" }, { dedupeKey: "quality|Race|src/a.ts" }),
      d("D-3", { type: "supersede", target: { kind: "ac", storyId: "US-2", acId: "AC-3" }, newText: "returns 0" }),
    ]);
    expect(text).not.toContain("D-1");
    expect(text).toContain("D-2 waived: Race (src/a.ts) — US-5 owns it");
    expect(text).toContain("D-3 superseded US-2 AC-3: returns 0");
  });

  test("empty when nothing was waived or superseded", () => {
    expect(formatDecisionsForPrompt([d("D-1", { type: "fix", instruction: "x" })])).toBe("");
  });
});
