import { afterEach, describe, expect, mock, test } from "bun:test";
import { makeBotFixEnv, makeBotReviewDeps, makeNaxConfig, makeTestRuntime } from "@test/helpers";
import { _botReviewDeps, runBotReview } from "@/bot/review-run";
import type { NaxRuntime } from "@/runtime";

const original = { ..._botReviewDeps };
const runtimes: NaxRuntime[] = [];
afterEach(async () => {
  Object.assign(_botReviewDeps, original);
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
});

describe("runBotReview prompt audit", () => {
  test("AC-1 gives the runtime the resolved PR feature name", async () => {
    const config = makeNaxConfig({ execution: { iterationDelayMs: 0 } });
    const runtime = makeTestRuntime({ config });
    runtimes.push(runtime);
    const info = { ...makeBotFixEnv().info, number: 7 };
    const create = mock<typeof _botReviewDeps.createRuntime>(() => runtime);
    Object.assign(_botReviewDeps, {
      ...makeBotReviewDeps({ config, runtime, info: () => info }),
      createRuntime: create,
      runPrReview: async () => ({ ran: false, why: "test stops before posting" }),
    });

    const result = await runBotReview({ dir: "/repo", pr: 7, profiles: [], interactive: false });

    expect(result.outcome).toBe("not-reviewed");
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(expect.anything(), "/repo", { featureName: "bot-pr-7" });
  });
});
