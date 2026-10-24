import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeBotFixDeps, makeBotFixEnv, makeTestRuntime } from "@test/helpers";
import * as bot from "@/bot";
import type { BotCheckSource } from "@/bot/checks";
import { _botFixDeps, runBotFix } from "@/bot/fix-run";
import { _fixStepsDeps, fixStep } from "@/bot/fix-steps";

const original = { ..._botFixDeps };
const originalSteps = { ..._fixStepsDeps };
const input = { dir: "/repo", pr: 42, profiles: [], interactive: false };
const refusal =
  "the base branch has no nax config and no AGENTS.md or CLAUDE.md checks; run nax setup, or pass --trust to run the package scripts nax detected";
let env: ReturnType<typeof makeBotFixEnv>;
let runtime: ReturnType<typeof makeTestRuntime>;
const session = mock<typeof _fixStepsDeps.runBranchFix>(async () => ({ autoCommitted: false, dirty: false }));
const resolve = mock<typeof _botFixDeps.resolveBotChecks>(async () => env.checks);
const setup = mock<typeof _botFixDeps.runPreRunSteps>(async () => {});

beforeEach(() => {
  env = makeBotFixEnv([{ kind: "finding", key: "f1", issue: "Fix defect", severity: "minor" }]);
  env = { ...env, checks: { source: "detected", gates: [{ name: "test", command: "npm test" }], preRun: [] } };
  runtime = makeTestRuntime({ config: env.config });
  session.mockClear();
  resolve.mockClear();
  setup.mockClear();
  Object.assign(_botFixDeps, {
    ...makeBotFixDeps(env, runtime),
    resolveBotChecks: resolve,
    runPreRunSteps: setup,
    fixStep,
    checkStep: async () => ({ patch: { outcome: "no-change" }, exit: "no-change" }),
    reportStep: async () => ({ patch: {}, exit: "done" }),
  });
  Object.assign(_fixStepsDeps, { runBranchFix: session, readHead: async () => "h1" });
});
afterEach(async () => {
  Object.assign(_botFixDeps, original);
  Object.assign(_fixStepsDeps, originalSteps);
  await runtime.close();
});

describe("runBotFix detected-check trust", () => {
  test("AC-2 never starts the agreed-item session without trust", async () => {
    await runBotFix(input);
    expect(session).not.toHaveBeenCalled();
  });
  test("AC-1 refuses detected checks before setup or the agreed-item session", async () => {
    expect(await runBotFix(input)).toMatchObject({ outcome: "refused", reason: refusal });
    expect(session).not.toHaveBeenCalled();
    expect(setup).not.toHaveBeenCalled();
  });
  test.each([
    ["detected", true],
    ["config", undefined],
    ["agents-md", undefined],
  ] satisfies [BotCheckSource, boolean | undefined][])(
    "AC-3/4/5 runs %s checks with trust=%s",
    async (source, trust) => {
      env = { ...env, checks: { ...env.checks, source } };
      await runBotFix({ ...input, ...(trust === true && { trust: true }) });
      expect(session).toHaveBeenCalledTimes(1);
    },
  );
  test("AC-6 refuses saved version 3 detected checks without re-resolving", async () => {
    env = { ...env, review: { ...env.review, version: 3, checks: env.checks, events: [] } };
    _botFixDeps.loadLatestReview = async () => env.review;
    expect(await runBotFix(input)).toMatchObject({ outcome: "refused", reason: refusal });
    expect(resolve).not.toHaveBeenCalled();
    expect(session).not.toHaveBeenCalled();
  });
  test("trust does not authorize an untrusted PR", async () => {
    _botFixDeps.classifyPrTrust = async () => ({ trusted: false, headSha: "h1", reasons: ["no write access"] });
    expect(await runBotFix({ ...input, trust: true })).toMatchObject({
      outcome: "refused",
      reason: "untrusted PR: no write access",
    });
    expect(session).not.toHaveBeenCalled();
  });
  test("AC-10 exports actionable detected refusal from the bot barrel", () => {
    const message = Reflect.get(bot, "BOT_FIX_DETECTED_REFUSAL");
    expect(message).toBe(refusal);
    expect(message).toContain("run nax setup");
    expect(message).toContain("--trust");
  });
});
