import { afterEach, describe, expect, test } from "bun:test";
import { makeSpawn } from "@test/helpers";
import * as bot from "@/bot";
import { _savedFixDeps } from "@/bot/saved-fix";
import { _gitDeps } from "@/utils/git";

const original = _gitDeps.spawn;
afterEach(() => {
  _gitDeps.spawn = original;
});

describe("botGit", () => {
  test("AC-1 barrel runner disables hooks and retains shared environment hardening", async () => {
    const spawn = makeSpawn();
    _gitDeps.spawn = spawn.spawn;
    await bot.botGit(["rev-parse", "HEAD"], "/repo");
    expect(bot.BOT_GIT_HOOKS_OFF).toEqual(["-c", "core.hooksPath=/dev/null"]);
    expect(spawn.calls[0]?.cmd).toEqual(["git", "-c", "core.hooksPath=/dev/null", "rev-parse", "HEAD"]);
    expect(spawn.calls[0]?.opts.cwd).toBe("/repo");
    expect(spawn.lastEnv().GIT_CONFIG_VALUE_0).toBe("false");
  });
  test("AC-2 status hardening recognizes the verb after the config pair", async () => {
    const spawn = makeSpawn();
    _gitDeps.spawn = spawn.spawn;
    await bot.botGit(["status", "--porcelain"], "/repo");
    expect(spawn.calls[0]?.cmd).toEqual([
      "git",
      "-c",
      "core.hooksPath=/dev/null",
      "status",
      "--ignore-submodules=dirty",
      "--porcelain",
    ]);
  });
  test("AC-3 forwards the deadline and kills a hung git", async () => {
    let killed = false;
    _gitDeps.spawn = makeSpawn(() => ({
      hang: true,
      killResolvesExited: true,
      onKill: () => {
        killed = true;
      },
    })).spawn;
    expect(await bot.botGit(["fetch"], "/repo", 50)).toMatchObject({ timedOut: true, exitCode: 1 });
    expect(killed).toBe(true);
  });
  test.each([
    ["AC-4 checkout", bot._checkoutDeps],
    ["AC-5 fix input", bot._fixInputDeps],
    ["AC-6 fix steps", bot._fixStepsDeps],
    ["AC-7 gate baseline", bot._gateBaselineDeps],
    ["AC-8 saved fix", _savedFixDeps],
    ["AC-9 review", bot._botReviewDeps],
    ["AC-10 checks", bot._botChecksDeps],
    ["AC-11 base config", bot._baseConfigDeps],
  ])("%s defaults to botGit", (_name, deps) => {
    expect(bot.botGit).toBeFunction();
    expect(deps.runGit).toBe(bot.botGit);
  });
});
