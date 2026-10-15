/**
 * Timeout escalation of executeWithTimeout (#2555 item 14): after a timeout the
 * process group is SIGKILLed once the grace period has passed even when the
 * /bin/sh leader already exited, because group members may ignore SIGTERM.
 * Driven through `_executorDeps` (killProcessGroup + timers) on a virtual clock.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeFakeClock, makeSpawn, makeSpawnResult, waitForCondition } from "@test/helpers";
import { _executorDeps, executeWithTimeout } from "@/verification/executor";

const TIMEOUT_S = 1;
const GRACE_MS = 5_000;
const PID = 8765;

interface KillCall {
  pid: number;
  signal: string | number;
  fallback: boolean | undefined;
}

let original: typeof _executorDeps;
let kills: KillCall[];
let clock: ReturnType<typeof makeFakeClock>;
let groupAlive: boolean;
let leaderDiesOnSigterm: boolean;
let resolveExited: (code: number) => void;

beforeEach(() => {
  original = { ..._executorDeps };
  kills = [];
  groupAlive = true;
  leaderDiesOnSigterm = true;
  clock = makeFakeClock();
  _executorDeps.setTimeout = clock.setTimeout as typeof _executorDeps.setTimeout;
  _executorDeps.clearTimeout = clock.clearTimeout as typeof _executorDeps.clearTimeout;
  _executorDeps.killProcessGroup = (pid, signal, opts) => {
    kills.push({ pid, signal, fallback: opts?.singleProcessFallback });
    if (signal === 0) return groupAlive;
    if (signal === "SIGTERM" && leaderDiesOnSigterm) resolveExited(143);
    return true;
  };
  const exited = new Promise<number>((resolve) => {
    resolveExited = resolve;
  });
  _executorDeps.spawn = makeSpawn(() => {
    const proc = makeSpawnResult({ pid: PID });
    Object.defineProperty(proc, "exited", { value: exited });
    return proc;
  }).spawn;
});

afterEach(() => {
  Object.assign(_executorDeps, original);
});

async function startRun() {
  const pending = executeWithTimeout("bun test", TIMEOUT_S, undefined, { gracePeriodMs: GRACE_MS, drainTimeoutMs: 10 });
  await waitForCondition(() => clock.pending() > 0);
  return { pending };
}

describe("executeWithTimeout — SIGKILL after a timeout", () => {
  test("SIGKILLs the group after the grace period although the leader already exited", async () => {
    const { pending } = await startRun();
    await clock.advance(TIMEOUT_S * 1000);
    // A group with members left is waited out to the end of the grace period, so the call settles only after it.
    await waitForCondition(() => kills.some((k) => k.signal === 0));
    await clock.advance(GRACE_MS);
    const result = await pending;

    expect(result.timeout).toBe(true);
    expect(kills.map((k) => k.signal)).toEqual(["SIGTERM", 0, "SIGKILL"]);
    expect(kills.filter((k) => k.signal === "SIGKILL")).toEqual([{ pid: PID, signal: "SIGKILL", fallback: false }]);
    expect(clock.pending()).toBe(0);
  });

  // The Linux CI case: a SIGTERMed child stays a zombie group member until reaped, so the group probe
  // still finds it. The SIGKILL timer then fires instead of being cancelled; it must still reach clearTimeout.
  test("every armed timer reaches clearTimeout when the group outlives the leader", async () => {
    const armed: unknown[] = [];
    const cleared = new Set<unknown>();
    const { setTimeout: arm, clearTimeout: clear } = _executorDeps;
    _executorDeps.setTimeout = (fn, ms) => {
      const id = arm(fn, ms);
      armed.push(id);
      return id;
    };
    _executorDeps.clearTimeout = (id) => {
      cleared.add(id);
      clear(id);
    };
    const { pending } = await startRun();
    await clock.advance(TIMEOUT_S * 1000);
    await waitForCondition(() => kills.some((k) => k.signal === 0));
    await clock.advance(GRACE_MS);
    await pending;

    expect(armed.length).toBeGreaterThan(0);
    expect(armed.filter((id) => !cleared.has(id))).toEqual([]);
  });

  test("leaves no timer armed and sends no SIGKILL when the group is already empty", async () => {
    groupAlive = false;
    const { pending } = await startRun();
    await clock.advance(TIMEOUT_S * 1000);
    await pending;

    expect(clock.pending()).toBe(0);
    await clock.advance(GRACE_MS);
    expect(kills.some((k) => k.signal === "SIGKILL")).toBe(false);
  });

  test("a leader that ignores SIGTERM is SIGKILLed at the end of the grace period, with the pid fallback allowed", async () => {
    leaderDiesOnSigterm = false;
    const { pending } = await startRun();
    await clock.advance(TIMEOUT_S * 1000);
    await clock.advance(GRACE_MS);
    resolveExited(137);
    await pending;

    expect(kills.filter((k) => k.signal === "SIGKILL")).toEqual([{ pid: PID, signal: "SIGKILL", fallback: true }]);
  });
});
