import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeBotFixEnv, makeNaxConfig } from "@test/helpers";
import * as bot from "@/bot";
import type { GateCommand } from "@/finish/gates/quality";
import type { CiWaitOutcome } from "@/workflow/ci-wait";

const original = { ...bot._fixStepsDeps };
beforeEach(() => {
  bot._fixStepsDeps.runGit = async () => ({ exitCode: 0, stdout: "", stderr: "" });
});
afterEach(() => Object.assign(bot._fixStepsDeps, original));
const state = (): bot.BotFixState => ({ step: "gates", timings: {} });
const commands = (): GateCommand[] => [
  { name: "test", command: ["test-command", "second-command"], cwd: "/snapshot" },
  { name: "e2e", command: "journey-command", setup: "setup-command", cwd: "/snapshot" },
];

function fakeGates(passed = true) {
  const run = mock(async () => ({ passed, failing: passed ? [] : ["test"], ran: ["test", "e2e"], output: "" }));
  bot._fixStepsDeps.runQualityGates = run;
  return run;
}
function gateEnv() {
  const env = makeBotFixEnv();
  return {
    ...env,
    config: makeNaxConfig({ bot: { gateRepairRounds: 0 } }),
    checks: { ...env.checks, gates: commands() },
  };
}

describe("gatesStep", () => {
  test("checks AC-14 runs saved test command in worktree", async () => {
    const run = fakeGates();
    const base = makeBotFixEnv();
    const env = { ...base, checks: { ...base.checks, gates: [{ name: "test", command: "npm run test" }] } };
    expect(await bot.gatesStep(env, state())).toEqual({ exit: "passed", patch: {} });
    expect(run).toHaveBeenCalledWith(
      env.checkout.worktree,
      [{ name: "test", command: "npm run test", cwd: env.checkout.worktree }],
      { onGate: expect.any(Function) },
    );
  });
  test("runs arrays and setup commands with worktree cwd without mutating saved gates", async () => {
    const run = fakeGates();
    const env = gateEnv();
    await bot.gatesStep(env, state());
    expect(run).toHaveBeenCalledWith(
      env.checkout.worktree,
      commands().map((gate) => ({ ...gate, cwd: env.checkout.worktree })),
      { onGate: expect.any(Function) },
    );
    expect(env.checks.gates).toEqual(commands());
  });
  test("checks AC-15 empty gates skips runner and reports no-gates", async () => {
    const run = fakeGates();
    expect(await bot.gatesStep(makeBotFixEnv(), state())).toEqual({ exit: "no-gates", patch: { outcome: "no-gates" } });
    expect(run).not.toHaveBeenCalled();
  });
  test("red gates report failure and failing names", async () => {
    fakeGates(false);
    fakeBaseline(undefined);
    expect(await bot.gatesStep(gateEnv(), state())).toEqual({
      exit: "failed",
      patch: {
        gateTails: [{ name: "test", tail: "(no output captured)" }],
        failingGates: ["test"],
        ciOutcome: "green",
        outcome: "gates-failed",
      },
    });
  });
});

function fakeBaseline(failing: readonly string[] | undefined, ci: CiWaitOutcome = "green") {
  const onHead = mock(async (_worktree: string, _headSha: string, _gates: GateCommand[]) => failing);
  bot._fixStepsDeps.failingOnHead = onHead;
  bot._fixStepsDeps.readHeadCi = async () => ({ outcome: ci, detail: "" });
  return onHead;
}

describe("gatesStep baseline (nax#2631)", () => {
  test("re-runs only the failing gates on the unmodified head", async () => {
    fakeGates(false);
    const onHead = fakeBaseline(["test"]);
    const env = gateEnv();
    await bot.gatesStep(env, state());
    expect(onHead).toHaveBeenCalledWith(env.checkout.worktree, env.info.headSha, [
      { ...commands()[0], cwd: env.checkout.worktree },
    ]);
  });
  test("a gate red on the unmodified head too is baseline-red, with CI's verdict on that head", async () => {
    fakeGates(false);
    fakeBaseline(["test"], "green");
    expect(await bot.gatesStep(gateEnv(), state())).toEqual({
      exit: "failed",
      patch: {
        gateTails: [{ name: "test", tail: "(no output captured)" }],
        failingGates: ["test"],
        baselineFailing: ["test"],
        ciOutcome: "green",
        outcome: "baseline-red",
      },
    });
  });
  test("a gate green on the unmodified head stays the fix's failure", async () => {
    fakeGates(false);
    fakeBaseline([], "failed");
    expect(await bot.gatesStep(gateEnv(), state())).toEqual({
      exit: "failed",
      patch: {
        gateTails: [{ name: "test", tail: "(no output captured)" }],
        failingGates: ["test"],
        baselineFailing: [],
        ciOutcome: "failed",
        outcome: "gates-failed",
      },
    });
  });
  test("a baseline run that throws leaves the plain gate failure", async () => {
    fakeGates(false);
    fakeBaseline(undefined);
    bot._fixStepsDeps.failingOnHead = async () => {
      throw new Error("spawn failed");
    };
    expect(await bot.gatesStep(gateEnv(), state())).toEqual({
      exit: "failed",
      patch: {
        gateTails: [{ name: "test", tail: "(no output captured)" }],
        failingGates: ["test"],
        ciOutcome: "green",
        outcome: "gates-failed",
      },
    });
  });
  test("passing gates read neither CI nor the head", async () => {
    fakeGates(true);
    const onHead = fakeBaseline(["test"]);
    expect(await bot.gatesStep(gateEnv(), state())).toEqual({ exit: "passed", patch: {} });
    expect(onHead).not.toHaveBeenCalled();
  });
});

describe("pushStep", () => {
  test("timeout reports unknown remote outcome rather than rejection", async () => {
    bot._fixStepsDeps.runGit = async (argv) => ({
      exitCode: argv[0] === "status" ? 0 : 1,
      stdout: "",
      stderr: "",
      timedOut: argv[0] === "push",
    });
    expect(await bot.pushStep(makeBotFixEnv(), state())).toMatchObject({
      exit: "rejected",
      patch: { outcome: "push-unknown" },
    });
  });
  test("AC-11/12/13/14/15 pushes the explicit PR ref without force and records the worktree HEAD", async () => {
    const runGit = mock(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const readHead = mock(async () => "pushed-sha");
    bot._fixStepsDeps.runGit = runGit;
    bot._fixStepsDeps.readHead = readHead;
    const baseEnv = makeBotFixEnv();
    const env = { ...baseEnv, info: { ...baseEnv.info, headRef: "feat/x" } };
    const result = await bot.pushStep(env, state());
    expect(runGit).toHaveBeenCalledTimes(2);
    expect(runGit).toHaveBeenCalledWith(["push", "origin", "HEAD:refs/heads/feat/x"], env.checkout.worktree, 120_000);
    expect(readHead).toHaveBeenCalledTimes(1);
    expect(readHead).toHaveBeenCalledWith(env.checkout.worktree);
    expect(result).toEqual({ exit: "pushed", patch: { pushedSha: "pushed-sha", outcome: "pushed" } });
  });
  test.each([1, 128])(
    "AC-16/17 exit %s reports rejection without reading or recording a pushed SHA",
    async (exitCode) => {
      bot._fixStepsDeps.runGit = mock(async (argv) => ({
        exitCode: argv[0] === "status" ? 0 : exitCode,
        stdout: "",
        stderr: "rejected",
      }));
      const readHead = mock(async () => "not-pushed");
      bot._fixStepsDeps.readHead = readHead;
      expect(await bot.pushStep(makeBotFixEnv(), state())).toEqual({
        exit: "rejected",
        patch: { outcome: "push-rejected" },
      });
      expect(readHead).not.toHaveBeenCalled();
    },
  );
});
