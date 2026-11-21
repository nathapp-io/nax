/**
 * Cancellation of runQualityCommand by an abort signal. Driven through
 * `_qualityRunnerDeps` (spawn, killProcessGroup, timers) on a virtual clock.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeFakeClock, makeSpawn, makeSpawnResult, waitForCondition } from "@test/helpers";
import { _qualityRunnerDeps, type QualityCommandResult, runQualityCommand } from "@/quality/runner";

const PID = 777;
const WORKDIR = "/tmp/project";

interface KillCall {
  pid: number;
  signal: string | number;
}

let original: typeof _qualityRunnerDeps;
let kills: KillCall[];
let spawns: number;
let clock: ReturnType<typeof makeFakeClock>;
let resolveExited: (code: number) => void;

beforeEach(() => {
  original = { ..._qualityRunnerDeps };
  kills = [];
  spawns = 0;
  clock = makeFakeClock();
  _qualityRunnerDeps.setTimeout = clock.setTimeout;
  _qualityRunnerDeps.clearTimeout = (handle) => {
    if (typeof handle === "number") clock.clearTimeout(handle);
  };
  _qualityRunnerDeps.killProcessGroup = (pid, signal) => {
    kills.push({ pid, signal });
    if (signal === 0) return false;
    if (signal === "SIGTERM") resolveExited(143);
    return true;
  };
  const exited = new Promise<number>((resolve) => {
    resolveExited = resolve;
  });
  _qualityRunnerDeps.spawn = makeSpawn(() => {
    spawns++;
    const proc = makeSpawnResult({ pid: PID });
    Object.defineProperty(proc, "exited", { value: exited });
    return proc;
  }).spawn;
});

afterEach(() => {
  Object.assign(_qualityRunnerDeps, original);
});

async function settle(pending: Promise<QualityCommandResult>): Promise<QualityCommandResult> {
  let done = false;
  void pending.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  for (let step = 0; step < 100 && !done; step++) await clock.advance(1_000);
  return await pending;
}

describe("runQualityCommand — abort signal", () => {
  test("AC-1: an already-aborted signal spawns nothing and reports cancelled", async () => {
    const result = await runQualityCommand({
      commandName: "lint",
      command: "x",
      workdir: WORKDIR,
      signal: AbortSignal.abort(),
    });
    expect(spawns).toBe(0);
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(-1);
    expect(result.timedOut).toBe(false);
    expect(result.output).toContain("cancelled");
  });

  test("AC-2: aborting a live child SIGTERMs its group", async () => {
    const controller = new AbortController();
    const pending = runQualityCommand({
      commandName: "lint",
      command: "x",
      workdir: WORKDIR,
      signal: controller.signal,
    });
    await waitForCondition(() => clock.pending() > 0);
    controller.abort();
    await settle(pending);
    expect(kills.some((k) => k.pid === PID && k.signal === "SIGTERM")).toBe(true);
  });

  test("AC-3: the aborted result is a non-timeout failure with no stopReason key", async () => {
    const controller = new AbortController();
    const pending = runQualityCommand({
      commandName: "lint",
      command: "x",
      workdir: WORKDIR,
      signal: controller.signal,
    });
    await waitForCondition(() => clock.pending() > 0);
    controller.abort();
    const result = await settle(pending);
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(-1);
    expect(result.timedOut).toBe(false);
    expect("stopReason" in result).toBe(false);
  });

  test("AC-4: a list command stops spawning after the abort", async () => {
    const controller = new AbortController();
    const pending = runQualityCommand({
      commandName: "lint",
      command: ["a", "b"],
      workdir: WORKDIR,
      signal: controller.signal,
    });
    await waitForCondition(() => clock.pending() > 0);
    controller.abort();
    const result = await settle(pending);
    expect(spawns).toBe(1);
    expect(result.success).toBe(false);
  });

  test("AC-5: an abort after the command resolved kills nothing", async () => {
    const controller = new AbortController();
    const pending = runQualityCommand({
      commandName: "lint",
      command: "x",
      workdir: WORKDIR,
      signal: controller.signal,
    });
    await waitForCondition(() => clock.pending() > 0);
    resolveExited(0);
    const result = await pending;
    controller.abort();
    expect(result.success).toBe(true);
    expect(kills).toEqual([]);
    expect(clock.pending()).toBe(0);
  });

  test("AC-6: a list command with an already-aborted signal spawns nothing", async () => {
    const result = await runQualityCommand({
      commandName: "lint",
      command: ["a", "b"],
      workdir: WORKDIR,
      signal: AbortSignal.abort(),
    });
    expect(spawns).toBe(0);
    expect(result.success).toBe(false);
  });
});
