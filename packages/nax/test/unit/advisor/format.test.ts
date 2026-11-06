import { describe, expect, test } from "bun:test";
import type { AdviceDecision } from "@/advisor";
import { summariseAdvisor } from "@/advisor";

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

describe("summariseAdvisor", () => {
  test("counts decisions, flagged ones, and decisions per kind", () => {
    expect(
      summariseAdvisor([
        d("D-1", { type: "fix", instruction: "x" }),
        d("D-2", { type: "hold", reason: "y" }, { needsHumanConfirm: true, kind: "finish-approval" }),
        d("D-3", { type: "waive", reason: "z" }),
      ]),
    ).toEqual({ decisions: 3, flagged: 1, byKind: { "finish-judgment": 2, "finish-approval": 1 } });
  });
});
