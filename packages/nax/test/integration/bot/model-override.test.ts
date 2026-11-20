/**
 * US-003 (#2999): an explicit `--model` that the base-snapshot config cannot resolve is refused
 * right after that config loads — before the runtime exists, before any install or build, and
 * without a run log. The checkout is still made and disposed, because the tiers can only be read
 * from the config in the checkout's base snapshot.
 *
 * `createRuntime` throws a sentinel: a refused override must never reach it, and a resolvable one
 * must, which is how each refusal test is proven to be about the model rather than unconditional.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeBotFixDeps, makeBotFixEnv, makeNaxConfig, makeTestRuntime } from "@test/helpers";
import { _botFixDeps, runBotFix } from "@/bot/fix-run";
import { _botReviewDeps, runBotReview } from "@/bot/review-run";

const RUNTIME_SENTINEL = "runtime-created";
const originalFix = { ..._botFixDeps };
const originalReview = { ..._botReviewDeps };
const fixInput = { dir: "/repo/sub", pr: 42, profiles: ["a"], interactive: false, trust: true };
const reviewInput = { dir: "/repo/sub", pr: 42, profiles: ["a"], interactive: false };

let env: ReturnType<typeof makeBotFixEnv>;
let runtime: ReturnType<typeof makeTestRuntime>;
let events: string[];

const load = mock<typeof _botFixDeps.loadBotConfig>(async () => env.config);
const create = mock<typeof _botFixDeps.createRuntime>(() => {
  throw new Error(RUNTIME_SENTINEL);
});
const preRun = mock<typeof _botFixDeps.runPreRunSteps>(async () => {
  events.push("pre-run");
});

beforeEach(() => {
  events = [];
  env = makeBotFixEnv();
  env = {
    ...env,
    config: makeNaxConfig(),
    checkout: {
      ...env.checkout,
      dispose: async () => {
        events.push("checkout-close");
      },
    },
  };
  runtime = makeTestRuntime({ config: env.config });
  for (const fn of [load, create, preRun]) fn.mockClear();
  load.mockImplementation(async () => env.config);
  preRun.mockImplementation(async () => {
    events.push("pre-run");
  });
  Object.assign(_botFixDeps, {
    ...makeBotFixDeps(env, runtime),
    gitToplevel: async () => "/repo",
    ensureProjectTrusted: async () => {},
    resolvePrRef: async () => env.ref,
    readPrInfo: async () => env.info,
    classifyPrTrust: async () => ({ trusted: true, headSha: env.info.headSha, reasons: [] }),
    preparePrCheckout: async () => env.checkout,
    loadBotConfig: load,
    createRuntime: create,
    runPreRunSteps: preRun,
  });
  Object.assign(_botReviewDeps, {
    gitToplevel: async () => "/repo",
    ensureProjectTrusted: async () => {},
    resolvePrRef: async () => env.ref,
    readPrInfo: async () => env.info,
    classifyPrTrust: async () => ({ trusted: true, headSha: env.info.headSha, reasons: [] }),
    preparePrCheckout: async () => env.checkout,
    loadBotConfig: load,
    createRuntime: create,
  });
});
afterEach(async () => {
  Object.assign(_botFixDeps, originalFix);
  Object.assign(_botReviewDeps, originalReview);
  await runtime.close();
});

describe("runBotFix --model refusal", () => {
  test("US-003 AC-10: an unresolvable model refuses with the resolver's reason", async () => {
    expect(await runBotFix({ ...fixInput, model: "nope" })).toMatchObject({
      outcome: "refused",
      reason: expect.stringMatching(/^invalid --model "nope"/),
    });
  });

  test("US-003 AC-11: no runtime is created for the refused override", async () => {
    await runBotFix({ ...fixInput, model: "nope" });
    expect(create).not.toHaveBeenCalled();
  });

  test("US-003 AC-12: no pre-run step of any kind runs for the refused override", async () => {
    await runBotFix({ ...fixInput, model: "nope" });
    expect(preRun).not.toHaveBeenCalled();
  });

  test("US-003 AC-16: the ready-only pass refuses the same override", async () => {
    expect(await runBotFix({ ...fixInput, readyOnly: true, model: "nope" })).toMatchObject({
      outcome: "refused",
      reason: expect.stringMatching(/^invalid --model "nope"/),
    });
    expect(create).not.toHaveBeenCalled();
  });

  test("US-003: the checkout is still created and disposed, and no run log is opened", async () => {
    const result = await runBotFix({ ...fixInput, model: "nope" });
    expect(events).toEqual(["checkout-close"]);
    expect(result).not.toHaveProperty("logPath");
  });

  test("US-003: a resolvable tier is not refused", async () => {
    await expect(runBotFix({ ...fixInput, model: "fast" })).rejects.toThrow(RUNTIME_SENTINEL);
    expect(load).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe("runBotReview --model refusal", () => {
  test("US-003 AC-13: an unresolvable model refuses with the resolver's reason", async () => {
    expect(await runBotReview({ ...reviewInput, model: "nope" })).toMatchObject({
      outcome: "refused",
      reason: expect.stringMatching(/^invalid --model "nope"/),
    });
  });

  test("US-003 AC-14: no runtime is created for the refused override", async () => {
    await runBotReview({ ...reviewInput, model: "nope" });
    expect(create).not.toHaveBeenCalled();
  });

  test("US-003: the review checkout is still disposed, and no run log is opened", async () => {
    const result = await runBotReview({ ...reviewInput, model: "nope" });
    expect(events).toEqual(["checkout-close"]);
    expect(result).not.toHaveProperty("logPath");
  });

  test("US-003: a resolvable tier is not refused", async () => {
    await expect(runBotReview({ ...reviewInput, model: "balanced" })).rejects.toThrow(RUNTIME_SENTINEL);
    expect(create).toHaveBeenCalledTimes(1);
  });
});
