/**
 * Advisor fixtures — complete `AdviceQuestion` / `AdviceDecision` defaults so a
 * test sets only the fields it asserts on, without a partial-object cast.
 */
import type { AdviceDecision, AdviceQuestion } from "@/advisor";

export function makeAdviceQuestion(overrides: Partial<AdviceQuestion> = {}): AdviceQuestion {
  return {
    id: "Q-1",
    kind: "finish-judgment",
    feature: "feat",
    askedAtSha: "sha",
    summary: "",
    evidence: [],
    options: [],
    ...overrides,
  };
}

export function makeAdviceDecision(overrides: Partial<AdviceDecision> = {}): AdviceDecision {
  return {
    id: "D-1",
    questionId: "Q-1",
    kind: "finish-judgment",
    chosenOptionId: "A",
    action: { type: "approve" },
    rationale: "",
    confidence: "high",
    reversible: true,
    needsHumanConfirm: false,
    decidedAt: "2026-10-10T00:00:00.000Z",
    model: "m",
    memoryMode: "stateless",
    auditRef: "advisor-audit/feat/D-1.json",
    ...overrides,
  };
}
