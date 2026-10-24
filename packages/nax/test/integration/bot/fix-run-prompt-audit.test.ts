import { afterEach, describe, expect, mock, test } from "bun:test";
import { makeBotFixDeps, makeBotFixEnv, makeNaxConfig, makeTestRuntime } from "@test/helpers";
import { _botFixDeps, runBotFix } from "@/bot/fix-run";
import type { NaxRuntime } from "@/runtime";

const original = { ..._botFixDeps };
const runtimes: NaxRuntime[] = [];
afterEach(async () => {
  Object.assign(_botFixDeps, original);
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
});

describe("runBotFix prompt audit", () => {
  test("AC-2 gives the runtime the resolved PR feature name", async () => {
    const env = { ...makeBotFixEnv(), config: makeNaxConfig({ execution: { iterationDelayMs: 0 } }) };
    const runtime = makeTestRuntime({ config: env.config });
    runtimes.push(runtime);
    const create = mock<typeof _botFixDeps.createRuntime>(() => runtime);
    Object.assign(_botFixDeps, {
      ...makeBotFixDeps(env, runtime),
      createRuntime: create,
      loadLatestReview: async () => null,
    });

    const result = await runBotFix({ dir: "/repo", pr: 42, profiles: [], interactive: false });

    expect(result.outcome).toBe("refused");
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(env.config, "/repo", { featureName: "bot-pr-42" });
  });
});
