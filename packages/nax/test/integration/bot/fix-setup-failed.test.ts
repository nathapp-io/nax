import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { makeBotFixDeps, makeBotFixEnv, makeTestRuntime } from "@test/helpers";
import { _fixReportDeps } from "@/bot/fix-report";
import { _botFixDeps, runBotFix } from "@/bot/fix-run";
import { _fixStepsDeps } from "@/bot/fix-steps";
import { NaxError } from "@/errors";
import { getLogger, initLogger, resetLogger } from "@/logger";

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

/**
 * US-003: the fresh checkout's build runs after a successful install. A build that fails for its own
 * reason (`PRE_RUN_FAILED`) must not read as a setup failure — the fix session still runs — while
 * anything else still ends the run.
 */
describe("runBotFix build failure", () => {
  const BUILD = "bun run build";
  const checks = {
    source: "config" as const,
    gates: [{ name: "build", command: BUILD }],
    preRun: [{ command: "bun install", timeoutSeconds: 60 }],
  };

  beforeEach(() => {
    _botFixDeps.resolveBotChecks = async () => checks;
    branchFix.mockImplementation(async () => ({ autoCommitted: false, dirty: false }));
    // The tree here is a fixture, not a checkout: stop the graph after the session it just ran.
    _botFixDeps.checkStep = async () => ({ patch: { outcome: "nothing" }, exit: "no-change" });
  });

  /** Fail the build invocation only; the install succeeded. */
  function failBuild(failure: unknown): void {
    _botFixDeps.runPreRunSteps = async ({ steps }) => {
      if (steps.some(({ command }) => command === BUILD)) throw failure;
    };
  }

  test("AC-7: a failed build warns and the fix session still runs", async () => {
    initLogger({ level: "silent" });
    const warn = spyOn(getLogger(), "warn");
    failBuild(new NaxError("[bot] build failed", "PRE_RUN_FAILED", { stage: "execution", command: BUILD }));
    try {
      const result = await runBotFix(input);
      expect(result).not.toMatchObject({ outcome: "setup-failed" });
      expect(branchFix).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        "bot-fix",
        "Fix build step failed",
        expect.objectContaining({ pr: 42, command: BUILD }),
      );
    } finally {
      warn.mockRestore();
      resetLogger();
    }
  });

  test("AC-8: any other build failure rejects the run", async () => {
    const failure = new Error("build blew up");
    failBuild(failure);
    await expect(runBotFix(input)).rejects.toBe(failure);
    expect(branchFix).not.toHaveBeenCalled();
  });
});
