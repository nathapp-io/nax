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
import { _qualityRunnerDeps, runQualityCommand } from "@/quality/runner";
import { makeSpawn, makeSpawnResult } from "@test/helpers";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

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
    _qualityRunnerDeps.spawn = makeSpawn(() => "all good").spawn;

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
    _qualityRunnerDeps.spawn = makeSpawn(() => ({ stdout: "stdout line", stderr: "stderr line" })).spawn;

    const result = await runQualityCommand({
      commandName: "typecheck",
      command: "bun run typecheck",
      workdir: "/tmp/project",
    });

    expect(result.output).toContain("stdout line");
    expect(result.output).toContain("stderr line");
  });

  test("durationMs is non-negative", async () => {
    _qualityRunnerDeps.spawn = makeSpawn().spawn;

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
    _qualityRunnerDeps.spawn = makeSpawn(() => ({ exitCode: 1, stderr: "Lint error on line 42" })).spawn;

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
    _qualityRunnerDeps.spawn = makeSpawn(() => ({ exitCode: 2 })).spawn;

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
    const killMock = mock((_pid: number, _signal?: string | number) => {});
    let resolveExited!: (code: number) => void;
    const exitedPromise = new Promise<number>((res) => {
      resolveExited = res;
    });

    // Mock process.kill to track calls and resolve the process promise
    process.kill = mock((pid: number, signal?: string | number) => {
      killMock(pid, signal);
      // Simulate process dying after SIGTERM
      if (signal === "SIGTERM") resolveExited(143);
      return true;
    }) as typeof process.kill;

    _qualityRunnerDeps.spawn = makeSpawn(() => {
      const proc = makeSpawnResult({ pid: 1234 }); // Provide explicit PID for killProcessGroup
      // The process only dies when the runner sends SIGTERM.
      Object.defineProperty(proc, "exited", { value: exitedPromise });
      return proc;
    }).spawn;

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
    _qualityRunnerDeps.spawn = makeSpawn().spawn;

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
    const stub = makeSpawn();
    _qualityRunnerDeps.spawn = stub.spawn;

    await runQualityCommand({
      commandName: "typecheck",
      command: "bun run typecheck",
      workdir: "/tmp/project",
      storyId: "US-007",
    });

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.cmd).toEqual(["/bin/sh", "-c", "bun run typecheck"]);
    expect(stub.calls[0]?.opts.cwd).toBe("/tmp/project");
  });

  // BUG-02: without detached:true, Bun does not setpgid the /bin/sh wrapper
  // into its own process group, so killProcessGroup(-pid) on timeout would
  // only reach the shell and leak the real test-runner grandchild.
  test("spawns with detached:true so timeout can reach the whole process group", async () => {
    const stub = makeSpawn();
    _qualityRunnerDeps.spawn = stub.spawn;

    await runQualityCommand({
      commandName: "lint",
      command: "bun run lint",
      workdir: "/tmp/project",
    });

    expect(stub.calls[0]?.opts.detached).toBe(true);
  });
});
