/**
 * Timeout escalation of runQualityCommand (#2555 item 14): a timed-out command
 * gets SIGTERM, then SIGKILL to the whole group after the grace period even when
 * the /bin/sh leader already exited, because group members may ignore SIGTERM.
 * Driven through `_qualityRunnerDeps` (killProcessGroup + timers) on a virtual
 * clock, so nothing sleeps.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeFakeClock, makeSpawn, makeSpawnResult, waitForCondition } from "@test/helpers";
import { _qualityRunnerDeps, runQualityCommand } from "@/quality/runner";

const TIMEOUT_MS = 1_000;
const GRACE_MS = 5_000;
const PID = 4321;

interface KillCall {
  pid: number;
  signal: string | number;
  fallback: boolean | undefined;
}

let original: typeof _qualityRunnerDeps;
let kills: KillCall[];
let clock: ReturnType<typeof makeFakeClock>;
let groupAlive: boolean;
let resolveExited: (code: number) => void;

beforeEach(() => {
  original = { ..._qualityRunnerDeps };
  kills = [];
  groupAlive = true;
  clock = makeFakeClock();
  _qualityRunnerDeps.setTimeout = clock.setTimeout as typeof _qualityRunnerDeps.setTimeout;
  _qualityRunnerDeps.clearTimeout = clock.clearTimeout as typeof _qualityRunnerDeps.clearTimeout;
  _qualityRunnerDeps.killProcessGroup = (pid, signal, opts) => {
    kills.push({ pid, signal, fallback: opts?.singleProcessFallback });
    // Signal 0 is the liveness probe; it reports whether any group member remains.
    if (signal === 0) return groupAlive;
    // The leader dies on SIGTERM; group members that ignore it stay alive.
    if (signal === "SIGTERM") resolveExited(143);
    return true;
  };
  const exited = new Promise<number>((resolve) => {
    resolveExited = resolve;
  });
  _qualityRunnerDeps.spawn = makeSpawn(() => {
    const proc = makeSpawnResult({ pid: PID });
    Object.defineProperty(proc, "exited", { value: exited });
    return proc;
  }).spawn;
});

afterEach(() => {
  Object.assign(_qualityRunnerDeps, original);
});

/** Starts a run and waits until its timeout timer is armed on the virtual clock. */
async function startRun() {
  const pending = runQualityCommand({
    commandName: "lint",
    command: "bun run lint",
    workdir: "/tmp/project",
    timeoutMs: TIMEOUT_MS,
  });
  await waitForCondition(() => clock.pending() > 0);
  return { pending };
}

describe("runQualityCommand — SIGKILL after a timeout", () => {
  test("SIGKILLs the group after the grace period although the leader already exited", async () => {
    const { pending } = await startRun();
    await clock.advance(TIMEOUT_MS);
    const result = await pending;

    expect(result.timedOut).toBe(true);
    expect(kills.map((k) => k.signal)).toEqual(["SIGTERM", 0]);

    await clock.advance(GRACE_MS);

    expect(kills.filter((k) => k.signal === "SIGKILL")).toEqual([{ pid: PID, signal: "SIGKILL", fallback: false }]);
  });

  test("never falls back to the bare pid once the leader has exited", async () => {
    const { pending } = await startRun();
    await clock.advance(TIMEOUT_MS);
    await pending;
    await clock.advance(GRACE_MS);

    expect(kills.filter((k) => k.signal !== "SIGTERM").every((k) => k.fallback === false)).toBe(true);
  });

  test("does not SIGKILL, and leaves no timer armed, when the group is already empty", async () => {
    groupAlive = false;
    const { pending } = await startRun();
    await clock.advance(TIMEOUT_MS);
    await pending;

    expect(clock.pending()).toBe(0);
    await clock.advance(GRACE_MS);
    expect(kills.some((k) => k.signal === "SIGKILL")).toBe(false);
  });

  test("the normal path arms nothing and sends no signal", async () => {
    const { pending } = await startRun();
    resolveExited(0);
    const result = await pending;

    expect(result.timedOut).toBe(false);
    expect(kills).toEqual([]);
    expect(clock.pending()).toBe(0);
  });
});
