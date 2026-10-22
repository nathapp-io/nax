import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeBotFixDeps, makeBotFixEnv, makeTestRuntime } from "@test/helpers";
import { _fixReportDeps } from "@/bot/fix-report";
import { _botFixDeps, runBotFix } from "@/bot/fix-run";
import { _fixStepsDeps } from "@/bot/fix-steps";
import { NaxError } from "@/errors";

const original = { ..._botFixDeps };
const reportOriginal = { ..._fixReportDeps };
const stepsOriginal = { ..._fixStepsDeps };
let runtime: ReturnType<typeof makeTestRuntime>;
const input = { dir: "/repo", pr: 42, profiles: [], interactive: false };
const branchFix = mock<typeof _fixStepsDeps.runBranchFix>();
const post = mock<typeof _fixReportDeps.postPrComment>(async () => ({ id: "comment" }));

beforeEach(() => {
  const base = makeBotFixEnv([{ kind: "finding", key: "fix-me", issue: "Fix this issue", severity: "important" }]);
  const env = { ...base, checks: { ...base.checks, preRun: [{ command: "bun install", timeoutSeconds: 60 }] } };
  runtime = makeTestRuntime({ config: env.config });
  Object.assign(_botFixDeps, makeBotFixDeps(env, runtime));
  _botFixDeps.runPreRunSteps = async () => {
    throw new NaxError("[execution] setup failed", "PRE_RUN_FAILED", { stage: "execution", command: "bun install" });
  };
  branchFix.mockClear();
  post.mockClear();
  _fixStepsDeps.runBranchFix = branchFix;
  _fixReportDeps.postPrComment = post;
});
afterEach(async () => {
  Object.assign(_botFixDeps, original);
  Object.assign(_fixReportDeps, reportOriginal);
  Object.assign(_fixStepsDeps, stepsOriginal);
  await runtime.close();
});

describe("runBotFix setup failure", () => {
  test("AC-1/2/3/11 reports the failed command without starting a fix session", async () => {
    const result = await runBotFix(input);
    expect(result).toMatchObject({ outcome: "setup-failed", setupFailed: "bun install", step: "done" });
    expect(branchFix).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[1]).toContain("Setup failed at `bun install`; nothing ran.");
  });
  test.each([
    new NaxError("other failure", "OTHER", { stage: "test" }),
    new Error("unexpected failure"),
    { code: "PRE_RUN_FAILED", context: { command: "bun install" } },
  ])("AC-4 propagates non-PRE_RUN_FAILED NaxErrors and other rejections unchanged: %s", async (failure) => {
    _botFixDeps.runPreRunSteps = async () => {
      throw failure;
    };
    await expect(runBotFix(input)).rejects.toBe(failure);
    expect(branchFix).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });
});
