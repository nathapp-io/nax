/** A1 caller 3: the advisor rules on an uncategorised TDD failure instead of a blind pause; queued heads-ups flush at stage end. */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { makeInteractionChain, makeNaxConfig, makeTestContext } from "@test/helpers";
import type { AdviceAction, AdviceResult, Advisor, QuestionDraft } from "@/advisor";
import { ADVISOR_DEFAULTS } from "@/config";
import type { PostRunInspectionResult } from "@/execution/post-run";
import { decideStageAction } from "@/execution/post-run";
import { _uncategorisedAdviceDeps, flushAdvisorHeadsUps } from "@/execution/uncategorised-advice";
import type { InteractionRequest } from "@/interaction/types";
import { makeInspectionOpts, makePlanResult } from "./_post-run-fixtures";

const original = { ..._uncategorisedAdviceDeps };
afterEach(() => Object.assign(_uncategorisedAdviceDeps, original));

const inspection = (over: Partial<PostRunInspectionResult> = {}): PostRunInspectionResult => ({
  agentResult: { success: false, exitCode: 1, output: "", rateLimited: false, durationMs: 1, estimatedCostUsd: 0 },
  selfVerificationFailed: false,
  needsHumanReview: false,
  providerUnavailable: false,
  combinedOutput: "tests failed somewhere",
  ...over,
});

function stub(reply: AdviceResult): QuestionDraft[] {
  const asked: QuestionDraft[] = [];
  _uncategorisedAdviceDeps.createAdvisor = () => {
    const a: Advisor = {
      advise: async (q) => {
        asked.push(q);
        return reply;
      },
      recordReuse: async () => null,
    };
    return a;
  };
  return asked;
}

const decided = (action: AdviceAction): AdviceResult => ({
  decision: {
    id: "D-3",
    questionId: "Q",
    kind: "uncategorised-failure",
    chosenOptionId: "A",
    action,
    rationale: "flaky boundary",
    confidence: "high",
    reversible: true,
    needsHumanConfirm: false,
    decidedAt: "t",
    model: "m",
    memoryMode: "stateless",
    auditRef: "a",
  },
});

function ctxWith(enabled: boolean) {
  return makeTestContext({
    config: makeNaxConfig({
      advisor: { ...ADVISOR_DEFAULTS, enabled, callers: { ...ADVISOR_DEFAULTS.callers, uncategorisedFailure: true } },
    }),
  });
}

const threeSession = makeInspectionOpts({ tddMode: { isLite: false, rollbackEnabled: false } });
const failed = makePlanResult({ success: false, failedPhases: ["verifier"] });

describe("caller 3 — uncategorised TDD failure", () => {
  test("disabled: today's pause, no advisor call", async () => {
    const asked = stub(decided({ type: "escalate-tier", reason: "r" }));
    const r = await decideStageAction(ctxWith(false), failed, inspection(), threeSession);
    expect(r.action).toBe("pause");
    expect(asked).toHaveLength(0);
  });

  test("retry-as-lite sets retryAsLite and escalates", async () => {
    const asked = stub(decided({ type: "retry-as-lite" }));
    const ctx = ctxWith(true);
    const r = await decideStageAction(ctx, failed, inspection(), threeSession);
    expect(r).toEqual({ action: "escalate", reason: "TDD uncategorised: retry as lite [advisor D-3]" });
    expect(ctx.retryAsLite).toBe(true);
    expect(asked[0]?.options.map((o) => o.type)).toEqual(["retry-as-lite", "escalate-tier", "defer"]);
  });

  test("escalate-tier escalates with the rationale", async () => {
    stub(decided({ type: "escalate-tier", reason: "r" }));
    const r = await decideStageAction(ctxWith(true), failed, inspection(), threeSession);
    expect(r).toEqual({ action: "escalate", reason: "flaky boundary [advisor D-3]" });
  });

  test("defer pauses with the diagnosis attached", async () => {
    stub(decided({ type: "defer", reason: "r" }));
    const r = await decideStageAction(ctxWith(true), failed, inspection(), threeSession);
    expect(r.action).toBe("pause");
    expect(r.action === "pause" && r.reason).toContain("[advisor D-3: flaky boundary]");
  });

  test("no decision falls back to today's pause", async () => {
    stub({ decision: null, fallbackReason: "no-json" });
    const r = await decideStageAction(ctxWith(true), failed, inspection(), threeSession);
    expect(r.action).toBe("pause");
  });

  test("a categorised failure never reaches the advisor", async () => {
    const asked = stub(decided({ type: "defer", reason: "r" }));
    await decideStageAction(ctxWith(true), failed, inspection({ failureCategory: "tests-failing" }), threeSession);
    expect(asked).toHaveLength(0);
  });
});

describe("flushAdvisorHeadsUps", () => {
  test("sends each queued text once through the interaction chain", async () => {
    const send = mock(async (_r: InteractionRequest) => undefined);
    const ctx = makeTestContext({ interaction: makeInteractionChain({ send }) });
    ctx.runtime.advisorHeadsUps.push(ctx.story.id, "advisor D-1 needs confirmation");
    await flushAdvisorHeadsUps(ctx);
    await flushAdvisorHeadsUps(ctx);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]?.detail).toContain("D-1");
  });

  test("no interaction channel: drains silently", async () => {
    const ctx = makeTestContext({ interaction: undefined });
    ctx.runtime.advisorHeadsUps.push(ctx.story.id, "x");
    await flushAdvisorHeadsUps(ctx);
    expect(ctx.runtime.advisorHeadsUps.drain(ctx.story.id)).toEqual([]);
  });
});
