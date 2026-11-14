/**
 * AC-8 (US-001, #2900): a real `gitWithTimeout` abort must leave no member of
 * the spawned git's process group alive.
 *
 * Unlike the unit tests, this one deliberately uses the REAL runtime spawn: it
 * signals only the process group and git process it captured from its own
 * `_gitDeps.spawn` wrapper, never a pid a fake reported.
 *
 * The git alias runs a shell which `exec`s `sleep 3003`. The marker it writes
 * its own pid to first is how the test knows the helper is running before it
 * aborts — a fixed sleep would be both banned here and flaky under load — and
 * is the handle the test reaps with if the abort ever leaves the helper behind.
 *
 * `ps` is read through `psCanReportProcessGroup()`: it is a setuid program that
 * a confined OS sandbox (and a sandboxed agent session) refuses, so the ps-based
 * case skips there. The liveness-probe case covers the same behaviour with
 * `kill(-pid, 0)`, which needs no `ps`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { _gitDeps, gitWithTimeout } from "@nathapp/nax-agent/internal";
import {
  cleanupTempDir,
  makeTempDir,
  psCanReportProcessGroup,
  waitForCondition,
  waitForFile,
  withDepsRestore,
  withTimeout,
} from "#test/helpers/index";

const POSIX = process.platform !== "win32";
const PS_AVAILABLE = POSIX && psCanReportProcessGroup();
const HELPER_TIMEOUT_MS = 5_000;
/** AC-8: the group must be empty within 2 s of the result. */
const GROUP_EMPTY_DEADLINE_MS = 2_000;

/** Every (pid, pgid) pair on the host, read the way AC-8 prescribes. */
function processGroups(): Array<[number, number]> {
  const listing = Bun.spawnSync(["ps", "-o", "pid=,pgid="], { stdout: "pipe", stderr: "pipe" });
  const pairs: Array<[number, number]> = [];
  for (const line of listing.stdout.toString().split("\n")) {
    const [pidField, groupField] = line.trim().split(/\s+/);
    const pid = Number(pidField);
    const group = Number(groupField);
    if (line.trim() === "" || !Number.isInteger(pid) || !Number.isInteger(group)) continue;
    pairs.push([pid, group]);
  }
  return pairs;
}

function groupMembers(pgid: number): number[] {
  return processGroups()
    .filter(([, group]) => group === pgid)
    .map(([pid]) => pid);
}

/** The group `pid` belongs to, or 0 when `ps` no longer lists it. */
function pgidOf(pid: number): number {
  return processGroups().find(([listed]) => listed === pid)?.[1] ?? 0;
}

/** Does a process group with this id still have a member? Needs no `ps`. */
function groupExists(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("gitWithTimeout: aborting a real git kills its process group", () => {
  withDepsRestore(_gitDeps);

  let dir: string;

  beforeEach(() => {
    dir = makeTempDir("git-group-kill-");
    Bun.spawnSync(["git", "init", "-q", dir]);
  });

  afterEach(() => cleanupTempDir(dir));

  /** A git whose alias starts a shell that `exec`s a long sleep, after recording its pid. */
  async function gitWithHangingAlias() {
    const marker = join(dir, "helper-started");
    const realSpawn = _gitDeps.spawn;
    let gitPid = 0;
    _gitDeps.spawn = (cmd, opts) => {
      const proc = realSpawn(cmd, opts);
      gitPid = proc.pid;
      return proc;
    };

    const controller = new AbortController();
    const result = gitWithTimeout(
      ["-c", `alias.hang=!sh -c 'echo $$ > ${marker} && exec sleep 3003'`, "hang"],
      dir,
      60_000,
      undefined,
      undefined,
      undefined,
      controller.signal,
    );
    // Not a fixed delay: the helper itself says it is running.
    await waitForFile(marker, HELPER_TIMEOUT_MS);
    const helperPid = Number((await Bun.file(marker).text()).trim());
    return { gitPid, helperPid, controller, result };
  }

  /** Kill what an assertion left behind, so a failure never leaks `sleep 3003`. */
  function reap(...pids: number[]): void {
    for (const pid of pids) {
      if (!Number.isInteger(pid) || pid <= 1) continue;
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // Not a group leader (or already gone) — the direct kill below is the fallback.
      }
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone — the expected case once the abort's group kill has run.
      }
    }
  }

  test.skipIf(!PS_AVAILABLE)("AC-8: nothing in the spawned git's process group survives the abort", async () => {
    const { gitPid, helperPid, controller, result } = await gitWithHangingAlias();
    const pgid = pgidOf(gitPid);
    try {
      // detached: true makes the git pid the group leader (setsid).
      expect(pgid).toBe(gitPid);
      expect(groupMembers(pgid).length).toBeGreaterThan(1);

      controller.abort();
      const settled = await withTimeout(result, HELPER_TIMEOUT_MS, "gitWithTimeout abort");
      expect(settled.aborted).toBe(true);

      let survivors: number[] = [];
      try {
        await waitForCondition(
          () => {
            survivors = groupMembers(pgid);
            return survivors.length === 0;
          },
          GROUP_EMPTY_DEADLINE_MS,
          20,
        );
      } catch {
        // Asserted with the survivor list below, which names what outlived the kill.
      }
      expect(survivors).toEqual([]);
    } finally {
      reap(pgid, helperPid);
    }
  });

  test.skipIf(!POSIX)("AC-8 (group liveness): git leads its own group and the abort empties it", async () => {
    const { gitPid, helperPid, controller, result } = await gitWithHangingAlias();
    try {
      // Same fact as the ps case, from `kill(-pid, 0)` — works where ps is refused.
      expect(groupExists(gitPid)).toBe(true);

      controller.abort();
      const settled = await withTimeout(result, HELPER_TIMEOUT_MS, "gitWithTimeout abort");
      expect(settled.aborted).toBe(true);

      let empty = false;
      try {
        await waitForCondition(
          () => {
            empty = !groupExists(gitPid);
            return empty;
          },
          GROUP_EMPTY_DEADLINE_MS,
          20,
        );
      } catch {
        // Asserted below, where a still-populated group is the failure.
      }
      expect(empty).toBe(true);
    } finally {
      reap(gitPid, helperPid);
    }
  });
});
