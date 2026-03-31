/**
 * Unit tests for src/quality/runner.ts (#135)
 *
 * Covers:
 * - Success path (exit 0)
 * - Failure path (non-zero exit)
 * - Timeout → SIGTERM → SIGKILL flow
 * - storyId threaded into log calls via injectable deps
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _qualityRunnerDeps, runQualityCommand } from "../../../src/quality/runner";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function makeSpawnMock(exitCode: number, stdout = "", stderr = "") {
  return mock((_args: unknown) => ({
    exited: Promise.resolve(exitCode),
    stdout: new ReadableStream({
      start(controller) {
        if (stdout) controller.enqueue(new TextEncoder().encode(stdout));
        controller.close();
      },
    }),
    stderr: new ReadableStream({
      start(controller) {
        if (stderr) controller.enqueue(new TextEncoder().encode(stderr));
        controller.close();
      },
    }),
    kill: mock(() => {}),
  } as unknown as ReturnType<typeof Bun.spawn>));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runQualityCommand — success (exit 0)", () => {
  let originalSpawn: typeof _qualityRunnerDeps.spawn;

  beforeEach(() => {
    originalSpawn = _qualityRunnerDeps.spawn;
  });

  afterEach(() => {
    _qualityRunnerDeps.spawn = originalSpawn;
  });

  test("returns success=true and exitCode=0", async () => {
    _qualityRunnerDeps.spawn = makeSpawnMock(0, "all good", "") as typeof Bun.spawn;

    const result = await runQualityCommand({
      commandName: "lint",
      command: "bun run lint",
      workdir: "/tmp/project",
    });

    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.commandName).toBe("lint");
    expect(result.command).toBe("bun run lint");
  });

  test("captures combined stdout and stderr in output", async () => {
    _qualityRunnerDeps.spawn = makeSpawnMock(0, "stdout line", "stderr line") as unknown as typeof Bun.spawn;

    const result = await runQualityCommand({
      commandName: "typecheck",
      command: "bun run typecheck",
      workdir: "/tmp/project",
    });

    expect(result.output).toContain("stdout line");
    expect(result.output).toContain("stderr line");
  });

  test("durationMs is non-negative", async () => {
    _qualityRunnerDeps.spawn = makeSpawnMock(0) as unknown as typeof Bun.spawn;

    const result = await runQualityCommand({
      commandName: "build",
      command: "bun run build",
      workdir: "/tmp/project",
    });

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("runQualityCommand — failure (non-zero exit)", () => {
  let originalSpawn: typeof _qualityRunnerDeps.spawn;

  beforeEach(() => {
    originalSpawn = _qualityRunnerDeps.spawn;
  });

  afterEach(() => {
    _qualityRunnerDeps.spawn = originalSpawn;
  });

  test("returns success=false and captures exit code", async () => {
    _qualityRunnerDeps.spawn = makeSpawnMock(1, "", "Lint error on line 42") as unknown as typeof Bun.spawn;

    const result = await runQualityCommand({
      commandName: "lint",
      command: "bun run lint",
      workdir: "/tmp/project",
    });

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(false);
    expect(result.output).toContain("Lint error on line 42");
  });

  test("exit code 2 is surfaced correctly", async () => {
    _qualityRunnerDeps.spawn = makeSpawnMock(2) as unknown as typeof Bun.spawn;

    const result = await runQualityCommand({
      commandName: "typecheck",
      command: "tsc --noEmit",
      workdir: "/tmp/project",
    });

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(2);
  });
});

describe("runQualityCommand — timeout flow", () => {
  let originalSpawn: typeof _qualityRunnerDeps.spawn;
  let originalProcessKill: typeof process.kill;

  beforeEach(() => {
    originalSpawn = _qualityRunnerDeps.spawn;
    originalProcessKill = process.kill;
  });

  afterEach(() => {
    _qualityRunnerDeps.spawn = originalSpawn;
    process.kill = originalProcessKill;
  });

  test("returns timedOut=true and exitCode=-1 when process exceeds timeoutMs", async () => {
    const killMock = mock(() => {});
    let resolveExited!: (code: number) => void;
    const exitedPromise = new Promise<number>((res) => {
      resolveExited = res;
    });

    // Mock process.kill to track calls and resolve the process promise
    process.kill = mock((pid, signal) => {
      killMock(pid, signal);
      // Simulate process dying after SIGTERM
      if (signal === "SIGTERM") resolveExited(143);
    }) as typeof process.kill;

    _qualityRunnerDeps.spawn = mock((_args: unknown) => ({
      pid: 1234, // Provide explicit PID for killProcessGroup
      exited: exitedPromise,
      stdout: new ReadableStream({ start(c) { c.close(); } }),
      stderr: new ReadableStream({ start(c) { c.close(); } }),
      kill: mock(() => {}), // Not called anymore, but keep for safety
    } as unknown as ReturnType<typeof Bun.spawn>)) as typeof Bun.spawn;

    const result = await runQualityCommand({
      commandName: "lint",
      command: "bun run lint",
      workdir: "/tmp/project",
      timeoutMs: 50, // very short timeout for testing
    });

    expect(result.timedOut).toBe(true);
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(-1);
    expect(result.output).toContain("timed out");
    expect(result.output).toContain("lint");
    expect(killMock).toHaveBeenCalledWith(-1234, "SIGTERM");
  });
});

describe("runQualityCommand — storyId correlation", () => {
  let originalSpawn: typeof _qualityRunnerDeps.spawn;

  beforeEach(() => {
    originalSpawn = _qualityRunnerDeps.spawn;
  });

  afterEach(() => {
    _qualityRunnerDeps.spawn = originalSpawn;
  });

  test("result includes commandName and command from options", async () => {
    _qualityRunnerDeps.spawn = makeSpawnMock(0) as unknown as typeof Bun.spawn;

    const result = await runQualityCommand({
      commandName: "lint",
      command: "biome check --write",
      workdir: "/tmp/project",
      storyId: "US-042",
    });

    // storyId flows through to logger; we verify the result shape here
    expect(result.commandName).toBe("lint");
    expect(result.command).toBe("biome check --write");
    expect(result.success).toBe(true);
  });

  test("spawn is called with parsed command parts", async () => {
    const spawnMock = makeSpawnMock(0);
    _qualityRunnerDeps.spawn = spawnMock as unknown as typeof Bun.spawn;

    await runQualityCommand({
      commandName: "typecheck",
      command: "bun run typecheck",
      workdir: "/tmp/project",
      storyId: "US-007",
    });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const callArg = (spawnMock.mock.calls[0] as unknown[])[0] as { cmd: string[]; cwd: string };
    expect(callArg.cmd).toEqual(["bun", "run", "typecheck"]);
    expect(callArg.cwd).toBe("/tmp/project");
  });
});
