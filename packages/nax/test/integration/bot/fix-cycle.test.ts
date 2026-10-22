import { describe, expect, mock, test } from "bun:test";
import { makeBotFixEnv } from "@test/helpers";
import { _fixCycleDeps, runBotFixCycle } from "@/bot/fix-cycle";
import type { BotFixInput, BotFixResult } from "@/bot/fix-run";
import type { BotReviewResult } from "@/bot/review-run";

const input = { dir: "/repo/sub", pr: 42, profiles: [], interactive: false, rereview: true };
const pushed: BotFixResult = {
  step: "done",
  timings: {},
  outcome: "pushed",
  pushedSha: "abcdef123",
  limitUsd: 8,
  spentUsd: 3,
};
const posted: BotReviewResult = {
  outcome: "posted",
  intent: "pass",
  quality: "approved",
  staticMode: false,
  checksSource: null,
  artifactPath: "/review",
  spentUsd: 2,
  earlierAnswered: 0,
  inlineFindings: 0,
  threadsAnswered: 0,
  commentsAnswered: 0,
  offLine: 0,
  failed: 0,
};
function fixture(fix: BotFixResult = pushed) {
  const env = makeBotFixEnv();
  const ready: BotFixResult = { step: "done", timings: {}, outcome: "ready-pass" };
  const runBotFix = mock(
    async (_input: BotFixInput): Promise<BotFixResult> => (runBotFix.mock.calls.length === 1 ? fix : ready),
  );
  const runBotReview = mock(async (): Promise<BotReviewResult> => posted);
  const waitForPrHead = mock(async (_input: unknown) => true);
  const gitToplevel = mock(async () => "/resolved");
  const resolvePrRef = mock(async () => env.ref);
  const deps = { ..._fixCycleDeps, runBotFix, runBotReview, waitForPrHead, gitToplevel, resolvePrRef };
  return { deps, ready, env };
}
describe("runBotFixCycle", () => {
  test.each(["nothing", "disabled"])("AC-1/2 %s returns only fix", async (mode) => {
    const fix: BotFixResult = mode === "nothing" ? { step: "done", timings: {}, outcome: "nothing" } : pushed;
    const { deps } = fixture(fix);
    expect(await runBotFixCycle({ ...input, rereview: mode !== "disabled" }, deps)).toEqual({ fix });
    expect(deps.runBotReview).not.toHaveBeenCalled();
    expect(deps.gitToplevel).not.toHaveBeenCalled();
  });
  test("AC-3/4/5/6/7 resolves head and chains exactly one review and ready pass within budget", async () => {
    const { deps, env, ready } = fixture();
    expect(await runBotFixCycle(input, deps)).toEqual({ fix: pushed, review: posted, ready });
    expect(deps.gitToplevel).toHaveBeenCalledWith(input.dir);
    expect(deps.resolvePrRef).toHaveBeenCalledWith(42, deps.forge, "/resolved");
    expect(deps.waitForPrHead.mock.calls[0]?.[0]).toEqual({ ref: env.ref, repoRoot: "/resolved", sha: "abcdef123" });
    expect(deps.runBotReview).toHaveBeenCalledWith({ ...input, costLimitUsd: 5 });
    expect(deps.runBotFix).toHaveBeenLastCalledWith({ ...input, readyOnly: true, costLimitUsd: 3 });
    expect(deps.runBotFix).toHaveBeenCalledTimes(2);
  });
  test("AC-8 timeout skips review with actionable message", async () => {
    const { deps } = fixture();
    deps.waitForPrHead.mockResolvedValue(false);
    expect(await runBotFixCycle(input, deps)).toEqual({
      fix: pushed,
      skipped: "PR head did not reach abcdef1 within 60 s; run nax bot review 42",
    });
    expect(deps.runBotReview).not.toHaveBeenCalled();
  });
  test("AC-9 exhausted fix budget skips review", async () => {
    const fix = { ...pushed, spentUsd: 8 };
    const { deps } = fixture(fix);
    expect(await runBotFixCycle(input, deps)).toEqual({ fix, skipped: "cost limit reached; run nax bot review 42" });
    expect(deps.runBotReview).not.toHaveBeenCalled();
  });
  test("AC-10 not-reviewed ends the cycle", async () => {
    const { deps } = fixture();
    const review: BotReviewResult = { outcome: "not-reviewed", reason: "no review" };
    deps.runBotReview.mockResolvedValue(review);
    expect(await runBotFixCycle(input, deps)).toEqual({ fix: pushed, review });
    expect(deps.runBotFix).toHaveBeenCalledTimes(1);
  });
  test.each(["gitToplevel", "resolvePrRef", "waitForPrHead", "runBotReview", "ready"] as const)(
    "AC-11/19 preserves push when %s throws",
    async (step) => {
      const { deps } = fixture();
      if (step === "ready")
        deps.runBotFix.mockImplementation(async () => {
          if (deps.runBotFix.mock.calls.length === 1) return pushed;
          throw new Error("chained failure");
        });
      else deps[step].mockRejectedValue(new Error("chained failure"));
      expect(await runBotFixCycle(input, deps)).toEqual({ fix: pushed, skipped: "chained failure" });
    },
  );
  test("explicit override wins over fix limit", async () => {
    const { deps } = fixture();
    await runBotFixCycle({ ...input, costLimitUsd: 10 }, deps);
    expect(deps.runBotReview).toHaveBeenCalledWith({ ...input, costLimitUsd: 7 });
  });
});
