import { afterEach, describe, expect, test } from "bun:test";
import { type GroupKillRecorder, makeGroupKillRecorder, makeSpawn } from "@test/helpers";
import * as bot from "@/bot";
import { _savedFixDeps } from "@/bot/saved-fix";
import { _gitDeps } from "@/utils/git";

/**
 * The pid the fake git reports. `makeSpawnResult`'s default (4242) belongs to
 * whatever holds that process group on the machine running the tests, so the
 * group kill is always driven through a recording stub here.
 */
const FAKE_GIT_PID = 8123;

const originalSpawn = _gitDeps.spawn;
const originalKillProcessGroup = _gitDeps.killProcessGroup;
afterEach(() => {
  _gitDeps.spawn = originalSpawn;
  _gitDeps.killProcessGroup = originalKillProcessGroup;
});

/**
 * A git that never exits until the SIGKILL resolves its `exited` promise — the
 * shape real `Bun.spawn` has, so gitWithTimeout's timeout path settles. Returns
 * the recorder that replaced the real `killProcessGroup` seam.
 */
function hangingGit(onKill: () => void): GroupKillRecorder {
  const groupKill = makeGroupKillRecorder();
  _gitDeps.spawn = makeSpawn(() => ({ hang: true, killResolvesExited: true, pid: FAKE_GIT_PID, onKill })).spawn;
  // The fake reports FAKE_GIT_PID: a real group kill would SIGKILL whatever holds
  // that group on the machine running the tests. Restored by afterEach above.
  _gitDeps.killProcessGroup = groupKill.killProcessGroup;
  return groupKill;
}

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
  test("US-002 AC-1 a hung fetch kills the process group with the fake git pid", async () => {
    const groupKill = hangingGit(() => {});

    await bot.botGit(["fetch"], "/repo", 50);

    expect(groupKill.calls).toEqual([{ pid: FAKE_GIT_PID, signal: "SIGKILL", singleProcessFallback: false }]);
  });
  test("AC-3 forwards the deadline and kills a hung git", async () => {
    let killed = false;
    // US-002 AC-3: a hanging fake spawn, a recording group-kill stub and a
    // proc.kill that resolves `exited` still yield the timed-out result.
    const groupKill = hangingGit(() => {
      killed = true;
    });

    expect(await bot.botGit(["fetch"], "/repo", 50)).toMatchObject({ timedOut: true, exitCode: 1 });
    expect(killed).toBe(true);
    // US-002 AC-3: the group kill reaches the seam once and the direct kill still
    // runs, so the call resolves the timed-out result rather than stalling.
    expect(groupKill.count()).toBe(1);
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
