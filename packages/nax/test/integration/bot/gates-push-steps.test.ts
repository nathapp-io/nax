import { afterEach, describe, expect, mock, test } from "bun:test";
import { makeBotFixEnv } from "@test/helpers";
import * as bot from "@/bot";
import type { GateCommand } from "@/finish/gates/quality";

const original = { ...bot._fixStepsDeps };
afterEach(() => Object.assign(bot._fixStepsDeps, original));
const state = (): bot.BotFixState => ({ step: "gates", timings: {} });
const commands = (): GateCommand[] => [
  { name: "test", command: ["test-command", "second-command"], cwd: "/snapshot" },
  { name: "e2e", command: "journey-command", setup: "setup-command", cwd: "/snapshot" },
];

function fakeGates(passed = true, resolved = commands()) {
  const resolve = mock(async () => resolved);
  const run = mock(async () => ({ passed, failing: passed ? [] : ["test"], ran: ["test", "e2e"], output: "" }));
  bot._fixStepsDeps.resolveGateCommands = resolve;
  bot._fixStepsDeps.runQualityGates = run;
  return { resolve, run };
}

describe("gatesStep", () => {
  test("AC-1/2/3 resolves only snapshot root gates and runs every command in the worktree", async () => {
    const resolved = commands();
    const { resolve, run } = fakeGates(true, resolved);
    const env = makeBotFixEnv();
    await bot.gatesStep(env, state());
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(env.checkout.snapshotDir, []);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(
      env.checkout.worktree,
      resolved.map((gate) => ({ ...gate, cwd: env.checkout.worktree })),
    );
    expect(resolved.map((gate) => gate.cwd)).toEqual(["/snapshot", "/snapshot"]);
  });
  test("AC-4/5/6 nothing configured skips the runner and reports no-gates", async () => {
    const { run } = fakeGates(true, []);
    const result = await bot.gatesStep(makeBotFixEnv(), state());
    expect(run).not.toHaveBeenCalled();
    expect(result).toEqual({ exit: "no-gates", patch: { outcome: "no-gates" } });
  });
  test("AC-7/8/9 red gates report failure and failing names", async () => {
    fakeGates(false);
    expect(await bot.gatesStep(makeBotFixEnv(), state())).toEqual({
      exit: "failed",
      patch: { failingGates: ["test"], outcome: "gates-failed" },
    });
  });
  test("AC-10 green gates return passed without claiming a push", async () => {
    fakeGates();
    expect(await bot.gatesStep(makeBotFixEnv(), state())).toEqual({ exit: "passed", patch: {} });
  });
});

describe("pushStep", () => {
  test("AC-11/12/13/14/15 pushes the explicit PR ref without force and records the worktree HEAD", async () => {
    const runGit = mock(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const readHead = mock(async () => "pushed-sha");
    bot._fixStepsDeps.runGit = runGit;
    bot._fixStepsDeps.readHead = readHead;
    const baseEnv = makeBotFixEnv();
    const env = { ...baseEnv, info: { ...baseEnv.info, headRef: "feat/x" } };
    const result = await bot.pushStep(env, state());
    expect(runGit).toHaveBeenCalledTimes(1);
    expect(runGit).toHaveBeenCalledWith(["push", "origin", "HEAD:refs/heads/feat/x"], env.checkout.worktree);
    expect(readHead).toHaveBeenCalledTimes(1);
    expect(readHead).toHaveBeenCalledWith(env.checkout.worktree);
    expect(result).toEqual({ exit: "pushed", patch: { pushedSha: "pushed-sha", outcome: "pushed" } });
  });
  test.each([1, 128])(
    "AC-16/17 exit %s reports rejection without reading or recording a pushed SHA",
    async (exitCode) => {
      bot._fixStepsDeps.runGit = mock(async () => ({ exitCode, stdout: "", stderr: "rejected" }));
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
