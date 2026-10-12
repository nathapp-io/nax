import { describe, expect, test } from "bun:test";
import { makeTestPRD, makeTestStory } from "@test/helpers";
import type { AdviceDecision, Advisor, BatchRequest, BatchResult, QuestionDraft } from "@/advisor";
import { costIfWrongOf, createLiveWorkflowAdvisor, dependentsOf, toWorkflowRuling } from "@/workflow/advisor-live";

function decision(over: Partial<AdviceDecision>): AdviceDecision {
  return {
    id: "D-1",
    questionId: "Q-1",
    kind: "residual",
    chosenOptionId: "A",
    action: { type: "waive", reason: "spec 3.2 allows it" },
    rationale: "the reviewer misread 3.2",
    confidence: "high",
    reversible: true,
    needsHumanConfirm: false,
    decidedAt: "t",
    model: "powerful",
    memoryMode: "stateless",
    auditRef: "advisor-audit/f/D-1.json",
    ...over,
  };
}

function fakeAdvisor(opts: {
  advise?: (q: QuestionDraft) => AdviceDecision | null;
  batch?: (r: BatchRequest) => BatchResult;
}): Advisor & { asked: QuestionDraft[]; batches: BatchRequest[] } {
  const asked: QuestionDraft[] = [];
  const batches: BatchRequest[] = [];
  return {
    asked,
    batches,
    advise: async (q) => {
      asked.push(q);
      return { decision: opts.advise?.(q) ?? null };
    },
    recordReuse: async () => null,
    adviseBatch: async (r) => {
      batches.push(r);
      return opts.batch ? opts.batch(r) : { kind: "residual", items: [], diagnoses: {} };
    },
  };
}

const finding = (id: string) => ({
  id,
  kind: "quality" as const,
  severity: "important" as const,
  issue: `issue ${id}`,
  file: "src/a.ts",
  line: 3,
});

describe("answerQuestion", () => {
  test("an answer decision returns its text; the question uses the implementer-question menu", async () => {
    const advisor = fakeAdvisor({
      advise: () => decision({ kind: "implementer-question", action: { type: "answer", text: "Use Postgres." } }),
    });
    const live = createLiveWorkflowAdvisor({ advisor, feature: "f", storyId: "US-3", dependents: [] });
    expect(await live.answerQuestion({ storyId: "US-3", status: "NEEDS_CONTEXT", concerns: "Which DB?" })).toBe(
      "Use Postgres.",
    );
    expect(advisor.asked[0]?.kind).toBe("implementer-question");
    expect(advisor.asked[0]?.options.map((o) => o.type)).toEqual(["answer", "hold"]);
    expect(advisor.asked[0]?.evidence[0]?.text).toContain("Which DB?");
  });

  test("hold or no decision -> null", async () => {
    const holds = fakeAdvisor({ advise: () => decision({ action: { type: "hold", reason: "ask a human" } }) });
    expect(
      await createLiveWorkflowAdvisor({ advisor: holds, feature: "f", storyId: "US-3", dependents: [] }).answerQuestion(
        { storyId: "US-3", status: "BLOCKED", concerns: "x" },
      ),
    ).toBeNull();
    const none = fakeAdvisor({});
    expect(
      await createLiveWorkflowAdvisor({ advisor: none, feature: "f", storyId: "US-3", dependents: [] }).answerQuestion({
        storyId: "US-3",
        status: "BLOCKED",
        concerns: "x",
      }),
    ).toBeNull();
  });
});

describe("ruleResidual", () => {
  test("one batch with a residual menu per item; carry only with dependents (Review Focus 3)", async () => {
    const advisor = fakeAdvisor({
      batch: (r) => ({
        kind: "residual",
        items:
          r.kind === "residual"
            ? r.items.map((q, i) => ({
                question: { ...q, id: `Q-${i}`, askedAtSha: "abc" },
                decision:
                  i === 0
                    ? decision({
                        id: "D-7",
                        action: { type: "carry", instruction: "Keep lock order", toStories: ["US-4"] },
                      })
                    : null,
                ...(i === 0 ? {} : { fallbackReason: "no answer for this item" }),
              }))
            : [],
        diagnoses: { "full-suite": "port clash" },
      }),
    });
    const live = createLiveWorkflowAdvisor({ advisor, feature: "f", storyId: "US-3", dependents: ["US-4"] });
    const answer = await live.ruleResidual({
      storyId: "US-3",
      items: [finding("F1"), finding("F2")],
      redGates: ["full-suite"],
    });
    const req = advisor.batches[0];
    if (req?.kind !== "residual") throw new Error("kind");
    expect(req.items.map((q) => q.options.map((o) => o.type))).toEqual([
      ["waive", "defer", "carry", "hold"],
      ["waive", "defer", "carry", "hold"],
    ]);
    expect(req.items[0]?.evidence[0]?.text).toContain("src/a.ts:3");
    expect(answer.rulings).toEqual([
      expect.objectContaining({
        findingId: "F1",
        action: "carry",
        text: "Keep lock order",
        toStories: ["US-4"],
        decisionId: "D-7",
        source: "advisor",
      }),
    ]);
    expect(answer.diagnoses).toEqual({ "full-suite": "port clash" });

    const noDeps = fakeAdvisor({});
    await createLiveWorkflowAdvisor({ advisor: noDeps, feature: "f", storyId: "US-3", dependents: [] }).ruleResidual({
      storyId: "US-3",
      items: [finding("F1")],
      redGates: [],
    });
    const r2 = noDeps.batches[0];
    if (r2?.kind !== "residual") throw new Error("kind");
    expect(r2.items[0]?.options.map((o) => o.type)).toEqual(["waive", "defer", "hold"]);
  });
});

describe("helpers", () => {
  test("toWorkflowRuling maps waive/defer/carry/hold; other actions -> null", () => {
    expect(toWorkflowRuling("F1", decision({}))).toMatchObject({
      findingId: "F1",
      action: "waive",
      text: "spec 3.2 allows it",
      why: "the reviewer misread 3.2",
    });
    expect(toWorkflowRuling("F1", decision({ action: { type: "defer", reason: "branch review" } }))?.action).toBe(
      "defer",
    );
    expect(toWorkflowRuling("F1", decision({ action: { type: "fix", instruction: "x" } }))).toBeNull();
  });

  test("costIfWrongOf (P3-R9)", () => {
    expect(costIfWrongOf(decision({}))).toBe("high confidence; reversible");
    expect(costIfWrongOf(decision({ confidence: "low", reversible: false, needsHumanConfirm: true }))).toBe(
      "low confidence; hard to undo; needs confirmation",
    );
  });

  test("dependentsOf: stories that list this one as a dependency and have not passed", () => {
    const prd = makeTestPRD([
      makeTestStory({ id: "US-3" }),
      makeTestStory({ id: "US-4", dependencies: ["US-3"], passes: false }),
      makeTestStory({ id: "US-5", dependencies: ["US-3"], passes: true }),
      makeTestStory({ id: "US-6", dependencies: ["US-1"], passes: false }),
    ]);
    expect(dependentsOf(prd, "US-3")).toEqual(["US-4"]);
  });
});
