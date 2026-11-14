/**
 * gitWithTimeout's process-group kill (US-001, #2900).
 *
 * `_gitDeps.spawn` is faked here and every faked reach to a kill stubs
 * `_gitDeps.killProcessGroup` first: `makeSpawnResult` reports pid 4242, and a
 * default (real) group kill would SIGKILL that group on the machine running
 * the tests.
 */
import { describe, expect, test } from "bun:test";
import { _gitDeps, gitWithTimeout, killProcessGroup } from "@nathapp/nax-agent/internal";
import { type FakeProcSpec, makeSpawn, makeSpawnResult, withDepsRestore } from "#test/helpers/index";

const DIR = "/repo";

interface GroupKillCall {
  pid: number;
  signal: NodeJS.Signals | number;
  opts: { readonly singleProcessFallback?: boolean } | undefined;
}

/** The kill arguments the ACs pin, as one value. */
function expectedGroupKill(pid: number): GroupKillCall {
  return { pid, signal: "SIGKILL", opts: { singleProcessFallback: false } };
}

describe("gitWithTimeout: process-group kill", () => {
  withDepsRestore(_gitDeps);

  /** A git that never answers until it is killed, plus the spawn stub that served it. */
  function hangingGit(extra: FakeProcSpec = {}) {
    const proc = makeSpawnResult({ hang: true, killResolvesExited: true, ...extra });
    const stub = makeSpawn(() => proc);
    _gitDeps.spawn = stub.spawn;
    return { proc, stub };
  }

  /** Replace the group-kill seam and record every call, so no real signal is sent. */
  function recordGroupKills(behaviour: () => boolean = () => true): GroupKillCall[] {
    const calls: GroupKillCall[] = [];
    _gitDeps.killProcessGroup = (pid, signal, opts) => {
      calls.push({ pid, signal, opts });
      return behaviour();
    };
    return calls;
  }

  test("AC-1: spawns git detached, so git leads its own process group", async () => {
    const { stub } = hangingGit();
    recordGroupKills();
    const controller = new AbortController();

    const pending = gitWithTimeout(["push"], DIR, 5_000, undefined, undefined, undefined, controller.signal);
    expect(stub.calls[0]?.opts.detached).toBe(true);
    controller.abort();
    await pending;
  });

  test("AC-2: an abort kills the whole group with SIGKILL once", async () => {
    const { proc } = hangingGit();
    const calls = recordGroupKills();
    const controller = new AbortController();

    const pending = gitWithTimeout(["push"], DIR, 5_000, undefined, undefined, undefined, controller.signal);
    controller.abort();
    await pending;

    expect(calls).toEqual([expectedGroupKill(proc.pid)]);
  });

  test("AC-3: an abort also kills the git process directly, after the group kill", async () => {
    const order: string[] = [];
    const { proc } = hangingGit({ onKill: () => order.push("direct") });
    recordGroupKills(() => {
      order.push("group");
      return true;
    });
    const controller = new AbortController();

    const pending = gitWithTimeout(["push"], DIR, 5_000, undefined, undefined, undefined, controller.signal);
    controller.abort();
    await pending;

    expect(proc.killed).toBe(true);
    expect(order).toEqual(["group", "direct"]);
  });

  test("AC-4: a timeout kills the whole group and resolves the timeout result", async () => {
    const { proc } = hangingGit();
    const calls = recordGroupKills();

    const result = await gitWithTimeout(["fetch"], DIR, 20);

    expect(calls).toEqual([expectedGroupKill(proc.pid)]);
    expect(result).toEqual({ stdout: "", stderr: "", exitCode: 1, timedOut: true });
  });

  test("AC-5: a throwing group kill does not prevent the direct kill or the aborted result", async () => {
    const { proc } = hangingGit();
    _gitDeps.killProcessGroup = () => {
      throw new Error("EPERM: process group not supported");
    };
    const controller = new AbortController();

    const pending = gitWithTimeout(["push"], DIR, 5_000, undefined, undefined, undefined, controller.signal);
    controller.abort();
    const result = await pending;

    expect(proc.killed).toBe(true);
    expect(result).toEqual({ stdout: "", stderr: "", exitCode: 1, aborted: true });
  });

  test("AC-6: a git that exits 0 without an abort or timeout never reaches the group kill", async () => {
    const calls = recordGroupKills();
    _gitDeps.spawn = makeSpawn(() => "").spawn;

    const result = await gitWithTimeout(["status"], DIR);

    expect(calls).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  test("AC-7: the group-kill seam defaults to the process-kill helper", () => {
    expect(_gitDeps.killProcessGroup).toBe(killProcessGroup);
  });

  test("AC-9: a group kill that reports sent without killing git still kills git directly", async () => {
    // The Windows shape: process groups do not exist, so the group kill is a
    // no-op that still reports sent. proc.kill is the only reach left.
    const { proc } = hangingGit();
    const calls = recordGroupKills(() => true);
    const controller = new AbortController();

    const pending = gitWithTimeout(["push"], DIR, 5_000, undefined, undefined, undefined, controller.signal);
    controller.abort();
    const result = await pending;

    expect(calls).toHaveLength(1);
    expect(proc.killed).toBe(true);
    expect(result.aborted).toBe(true);
  });

  test("AC-10: both kills throwing on an already-exited git resolves the aborted result", async () => {
    const proc = makeSpawnResult({ exitCode: 0 });
    proc.kill = () => {
      throw new Error("ESRCH: no such process");
    };
    _gitDeps.spawn = makeSpawn(() => proc).spawn;
    _gitDeps.killProcessGroup = () => {
      throw new Error("ESRCH: no such process group");
    };
    const controller = new AbortController();

    const pending = gitWithTimeout(["push"], DIR, 5_000, undefined, undefined, undefined, controller.signal);
    controller.abort();

    expect(await pending).toEqual({ stdout: "", stderr: "", exitCode: 1, aborted: true });
  });

  test("AC-11: a normal exit resolves the process's own stdout, stderr and exitCode", async () => {
    _gitDeps.spawn = makeSpawn(() => ({ exitCode: 0, stdout: "out\n", stderr: "err\n" })).spawn;

    const result = await gitWithTimeout(["status"], DIR);

    expect(result).toEqual({ stdout: "out\n", stderr: "err\n", exitCode: 0 });
    expect(Object.hasOwn(result, "timedOut")).toBe(false);
    expect(Object.hasOwn(result, "aborted")).toBe(false);
  });
});
