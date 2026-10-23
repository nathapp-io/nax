import { describe, expect, test } from "bun:test";
import type { AdviceDecision, AdviceQuestion } from "@/advisor";
import { buildMenu } from "@/advisor";
import { buildAdvisorPrompt } from "@/prompts";
import { ADVISOR_POLICY, FINISH_APPROVAL_READ_RULE } from "@/prompts/builders/advisor-builder";

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

  test("supersede is limited to a spec that cannot stand; disagreeing with a spec choice is a hold", () => {
    const p = buildAdvisorPrompt({ question, specPath: "s", prdText: "{}", priorDecisions: [], continuation: false });
    // A go-live replay superseded a spec's stated trade-off to match drifted code (spec §9 unsafe class).
    expect(p).toContain("even when the code's choice looks better");
    expect(p).toContain("only when the spec cannot stand as written");
    expect(p).toContain("choose hold");
    expect(p).not.toContain("The spec wins unless its premise is wrong");
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

const READ_RULE =
  "nax asks this question only after the branch review read every changed file, so decision policy 4 is met and you are not asked to review the whole diff again. Your reading is a spot-check: before you approve, open at least the changed file you judge riskiest. Use the changed files and the base commit the evidence names, when it names them. List every file you opened in inspectedFiles. Approve unless you find a concrete problem: a defect you can point to in a file, a conflict with the spec, or a deferred minor that should not ship. A hold names that problem; not having read the whole diff yourself is never a reason to hold.";
describe("advisor read instructions", () => {
  test("AC-6: policy 4 binds the reported review rather than the advisor spot-check", () => {
    expect(ADVISOR_POLICY).toContain(
      "4. A review that did not read the whole diff is never an approval. This binds the reviews the evidence reports, not your own reading: when the evidence says a review read every changed file, this rule is met.",
    );
  });
  test.each([
    ["AC-14", "finish-approval", false],
    ["AC-17", "finish-approval", true],
    ["AC-18", "finish-judgment", false],
  ] as const)("%s", (_ac, kind, continuation) => {
    const prompt = buildAdvisorPrompt({
      question: { ...question, kind },
      continuation,
      specPath: "s",
      prdText: "{}",
      priorDecisions: [],
    });
    expect(FINISH_APPROVAL_READ_RULE).toBe(READ_RULE);
    if (kind === "finish-approval") expect(prompt).toContain(READ_RULE);
    else expect(prompt).not.toContain(READ_RULE);
  });
  test.each([false, true])("AC-19 contract on continuation=%p", (continuation) => {
    const prompt = buildAdvisorPrompt({ question, continuation, specPath: "s", prdText: "{}", priorDecisions: [] });
    expect(prompt).toContain('"inspectedFiles": ["path"]');
    expect(prompt).toContain(
      'List every file you opened in "inspectedFiles"; an empty list means you ruled from the evidence alone.',
    );
  });
});
