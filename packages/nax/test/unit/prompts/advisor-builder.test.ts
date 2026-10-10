import { describe, expect, test } from "bun:test";
import type { AdviceDecision, AdviceQuestion } from "@/advisor";
import { buildMenu } from "@/advisor";
import { buildAdvisorPrompt } from "@/prompts";

const question: AdviceQuestion = {
  id: "Q-1",
  kind: "finish-judgment",
  feature: "feat",
  askedAtSha: "abc",
  summary: "Reviewer says Transport widened beyond the spec's one-method contract.",
  evidence: [{ source: "finding", ref: "finding #1", text: "Transport has open/close" }],
  options: buildMenu({ kind: "finish-judgment", citesSpecSection: "Design", acceptanceEnabledForStory: true }),
};

const prior: AdviceDecision = {
  id: "D-1",
  questionId: "Q-0",
  kind: "finish-judgment",
  chosenOptionId: "B",
  action: { type: "waive", reason: "covered by US-3" },
  rationale: "r",
  confidence: "high",
  reversible: true,
  needsHumanConfirm: false,
  decidedAt: "2026-10-10T00:00:00Z",
  model: "m",
  memoryMode: "stateless",
  auditRef: "a",
};

describe("buildAdvisorPrompt", () => {
  test("carries the policy, the spec path, the PRD, prior decisions, the menu and the reply contract", () => {
    const p = buildAdvisorPrompt({
      question,
      specPath: "docs/spec.md",
      prdText: '{"stories":[]}',
      priorDecisions: [prior],
      continuation: false,
    });
    expect(p).toContain("the most conservative option");
    expect(p).toContain("docs/spec.md");
    expect(p).toContain('{"stories":[]}');
    expect(p).toContain("D-1");
    for (const o of question.options) expect(p).toContain(`${o.id}. [${o.type}]`);
    expect(p).toContain('"optionId"');
  });

  test("a continuation turn sends only the new question, not the PRD or the policy again", () => {
    const p = buildAdvisorPrompt({
      question,
      specPath: "docs/spec.md",
      prdText: "PRD-BODY",
      priorDecisions: [],
      continuation: true,
    });
    expect(p).not.toContain("PRD-BODY");
    expect(p).toContain(question.summary);
  });
});
