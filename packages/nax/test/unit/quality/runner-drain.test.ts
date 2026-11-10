import { afterEach, describe, expect, mock, test } from "bun:test";
import { makeSpawn, makeSpawnResult } from "@test/helpers";
import { _qualityRunnerDeps, runQualityCommand, STREAM_DRAIN_TIMEOUT_MS } from "@/quality/runner";

const originalDeps = { ..._qualityRunnerDeps };
afterEach(() => Object.assign(_qualityRunnerDeps, originalDeps));

describe("quality runner stream drains", () => {
  test("AC-1: leader exit is not treated as a timeout while a background child holds a pipe", async () => {
    const start = Date.now();
    const result = await runQualityCommand({
      commandName: "lint",
      command: "sleep 20 & echo lint-clean",
      workdir: import.meta.dir,
      timeoutMs: 60_000,
    });

    expect(Date.now() - start).toBeLessThan(10_000);
    expect(result).toMatchObject({ success: true, exitCode: 0, timedOut: false });
    expect(result.output).toContain("lint-clean");
  });

  test.each([
    ["AC-2", 0, "", true],
    ["AC-5", 3, "partial\n", false],
  ] as const)("%s: bounds a stalled stdout stream and preserves leader result", async (_ac, code, output, success) => {
    const proc = makeSpawnResult({ pid: 7345, exitCode: code });
    Object.defineProperty(proc, "stdout", {
      value: new ReadableStream<Uint8Array>({
        start(controller) {
          if (output) controller.enqueue(new TextEncoder().encode(output));
        },
      }),
    });
    const spawn = makeSpawn(() => proc);
    const kill = mock(() => false);
    const timers = mock((fn: () => void, ms: number) => {
      if (ms === STREAM_DRAIN_TIMEOUT_MS) queueMicrotask(fn);
      return ms;
    });
    _qualityRunnerDeps.spawn = spawn.spawn;
    _qualityRunnerDeps.setTimeout = timers;
    _qualityRunnerDeps.clearTimeout = mock(() => {});
    _qualityRunnerDeps.killProcessGroup = kill;

    const result = await runQualityCommand({ commandName: "lint", command: "stub", workdir: import.meta.dir });

    expect(kill).toHaveBeenCalledWith(7345, "SIGTERM", { singleProcessFallback: false });
    expect(result.timedOut).toBe(false);
    expect(result.success).toBe(success);
    expect(result.exitCode).toBe(code);
    if (output) expect(result.output).toContain("partial");
  });

  test("AC-3: a normally closed command does not signal its process group", async () => {
    const kill = mock(() => false);
    _qualityRunnerDeps.killProcessGroup = kill;
    _qualityRunnerDeps.spawn = makeSpawn(() => "ok\n").spawn;

    const result = await runQualityCommand({ commandName: "lint", command: "echo ok", workdir: import.meta.dir });

    expect(result.output).toBe("ok\n");
    expect(kill).not.toHaveBeenCalled();
  });

  test("AC-4: collects output larger than the operating-system pipe buffer", async () => {
    const result = await runQualityCommand({
      commandName: "lint",
      command: "printf '%200000s' '' | tr ' ' x",
      workdir: import.meta.dir,
    });

    expect(result.success).toBe(true);
    expect(result.output.length).toBeGreaterThanOrEqual(200_000);
    expect(result.output.length).toBeLessThanOrEqual(200_001);
    expect(result.output.replace(/\n$/, "")).toBe("x".repeat(200_000));
  });

  test("AC-6: preserves the real command timeout", async () => {
    const result = await runQualityCommand({
      commandName: "lint",
      command: "sleep 30",
      workdir: import.meta.dir,
      timeoutMs: 200,
    });

    expect(result.timedOut).toBe(true);
    // Above the 5s SIGKILL grace: under the confined sandbox a killed group member can linger until it fires.
  }, 15_000);
});
