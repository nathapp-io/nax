import { afterEach, describe, expect, mock, test } from "bun:test";
import { makeBotFixDeps, makeBotFixEnv, makeBotReviewDeps, makeTestRuntime } from "@test/helpers";
import { _botFixDeps, BOT_FIX_GRAPH, runBotFix } from "@/bot/fix-run";
import { _fixStepsDeps } from "@/bot/fix-steps";
import { _botReviewDeps, runBotReview } from "@/bot/review-run";
import { totalSpendUsd } from "@/runtime";
import { runStepGraph } from "@/step-graph";

const originalFix = { ..._botFixDeps };
const originalSteps = { ..._fixStepsDeps };
const originalReview = { ..._botReviewDeps };
const runtimes: ReturnType<typeof makeTestRuntime>[] = [];
afterEach(async () => {
  Object.assign(_botFixDeps, originalFix);
  Object.assign(_fixStepsDeps, originalSteps);
  Object.assign(_botReviewDeps, originalReview);
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
});
const input = { dir: "/repo", pr: 42, profiles: [], interactive: false };
const items = [{ kind: "finding" as const, key: "f1", severity: "minor" as const, issue: "Leak", file: "a.ts" }];

function fixture() {
  const base = makeBotFixEnv(items);
  const env = { ...base, config: { ...base.config, bot: { ...base.config.bot, models: {}, costLimit: 7 } } };
  const runtime = makeTestRuntime({ config: env.config });
  runtimes.push(runtime);
  const empty = runtime.costAggregator.snapshot();
  let spent = 0;
  runtime.costAggregator.snapshot = () => ({ ...empty, totalCostUsd: spent / 2, totalErrorCostUsd: spent / 2 });
  const branchFix = mock<typeof _fixStepsDeps.runBranchFix>(async () => ({ dirty: false, autoCommitted: false }));
  _fixStepsDeps.runBranchFix = branchFix;
  _fixStepsDeps.readHead = async () => "fixed";
  const report = mock<typeof _botFixDeps.reportStep>(async () => ({ patch: {}, exit: "done" }));
  Object.assign(_botFixDeps, makeBotFixDeps(env, runtime), {
    resolveBotChecks: async () => {
      spent = 1.5; // Checks extraction is paid work before the first graph node.
      return env.checks;
    },
    checkStep: async () => ({ patch: { outcome: "no-change" }, exit: "no-change" }),
    reportStep: report,
  });
  return {
    env,
    runtime,
    branchFix,
    report,
    spend: (value: number) => {
      spent = value;
    },
  };
}

describe("runBotFix cost guard", () => {
  test("AC-1/2/3 stops before fix, reports boundary spend and never calls runBranchFix", async () => {
    const f = fixture();
    const result = await runBotFix({ ...input, costLimitUsd: 1 });
    expect(result).toMatchObject({ outcome: "cost-limit", costSpentUsd: 1.5, costLimitUsd: 1 });
    expect(f.branchFix).not.toHaveBeenCalled();
    expect(f.report.mock.calls[0]?.[1]).toMatchObject({ outcome: "cost-limit", costSpentUsd: 1.5, costLimitUsd: 1 });
  });
  test("stops at equality, not only above the boundary", async () => {
    const f = fixture();
    expect(await runBotFix({ ...input, costLimitUsd: 1.5 })).toMatchObject({ outcome: "cost-limit" });
    expect(f.branchFix).not.toHaveBeenCalled();
  });
  test("AC-4/11/12 runs below limit and reports canonical final spend, including report work", async () => {
    const f = fixture();
    _botFixDeps.reportStep = async () => {
      f.spend(2.25);
      return { patch: {}, exit: "done" };
    };
    expect(await runBotFix({ ...input, costLimitUsd: 2 })).toMatchObject({
      outcome: "no-change",
      spentUsd: 2.25,
      limitUsd: 2,
    });
    expect(f.branchFix).toHaveBeenCalledTimes(1);
    expect(totalSpendUsd(f.runtime.costAggregator.snapshot())).toBe(2.25);
  });
  test("AC-5 uses config bot.costLimit when no override is given", async () => {
    const f = fixture();
    expect(await runBotFix(input)).toMatchObject({ limitUsd: 7 });
    expect(f.report.mock.calls[0]?.[0].cost.limitUsd).toBe(7);
    expect(f.branchFix).toHaveBeenCalledTimes(1);
  });
  test("AC-6 restart at repair stops at report without invoking repair", async () => {
    const f = fixture();
    const repair = mock<typeof _botFixDeps.repairStep>();
    _botFixDeps.repairStep = repair;
    const state = await runStepGraph(
      BOT_FIX_GRAPH,
      { ...f.env, cost: { limitUsd: 1, spentUsd: () => 1.5 } },
      { step: "repair", timings: {} },
      { persist: async () => {} },
      { aborted: () => false, now: () => 0, costExceeded: () => true },
    );
    expect(state).toMatchObject({ step: "done", outcome: "cost-limit", costSpentUsd: 1.5, costLimitUsd: 1 });
    expect(f.report).toHaveBeenCalledTimes(1);
    expect(repair).not.toHaveBeenCalled();
  });
});

describe("runBotReview cost guard", () => {
  function reviewFixture() {
    const f = fixture();
    const review = mock<typeof _botReviewDeps.runPrReview>(async () => ({
      ran: true,
      verdict: {
        intent: "pass",
        quality: "approved",
        findings: [],
        threads: [],
        comments: [],
        cannotVerify: [],
        inspectedFiles: [],
      },
    }));
    Object.assign(
      _botReviewDeps,
      makeBotReviewDeps({ config: f.env.config, runtime: f.runtime, info: () => f.env.info }),
      {
        resolveBotChecks: async () => {
          f.spend(1.5);
          return f.env.checks;
        },
        runPrReview: review,
        postPrReview: async () => {
          f.spend(2.5);
          return {
            earlierAnswered: 0,
            inlineFindings: 0,
            threadsAnswered: 0,
            commentsAnswered: 0,
            offLine: 0,
            failed: 0,
          };
        },
      },
    );
    return { ...f, review };
  }
  test("AC-9/10 skips review after checks extraction exhausts the budget", async () => {
    const f = reviewFixture();
    expect(await runBotReview({ ...input, costLimitUsd: 1 })).toEqual({
      outcome: "not-reviewed",
      reason: "cost limit reached: 1.50 of 1.00 USD",
    });
    expect(f.review).not.toHaveBeenCalled();
  });
  test("AC-13 posted review reports final canonical spend and override limit", async () => {
    const f = reviewFixture();
    expect(await runBotReview({ ...input, costLimitUsd: 2 })).toMatchObject({
      outcome: "posted",
      spentUsd: 2.5,
      limitUsd: 2,
    });
    expect(f.review).toHaveBeenCalledTimes(1);
  });
});
