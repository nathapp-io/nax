import { describe, expect, test } from "bun:test";
import type { AdviceDecision } from "@/advisor";
import { formatDecisionsForPrompt, summariseAdvisor } from "@/advisor";

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

  test("a waive of a blocking finding is never handed to the reviewer as settled", () => {
    const text = formatDecisionsForPrompt([
      d("D-4", { type: "waive", reason: "x" }, { findingSeverity: "HIGH" }),
      d("D-5", { type: "waive", reason: "y" }, { findingSeverity: "LOW" }),
    ]);
    expect(text).not.toContain("D-4");
    expect(text).toContain("D-5");
  });

  test("empty when nothing was waived or superseded", () => {
    expect(formatDecisionsForPrompt([d("D-1", { type: "fix", instruction: "x" })])).toBe("");
  });
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
