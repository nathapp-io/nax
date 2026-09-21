/**
 * Unit tests for src/quality/runner.ts (#135)
 *
 * Covers:
 * - Success path (exit 0)
 * - Failure path (non-zero exit)
 * - Timeout → SIGTERM → SIGKILL flow
 * - storyId threaded into log calls via injectable deps
 * - `origin` discriminator (harness vs agent-tool console semantics)
 * - env stripping (secrets, AGENT=1 opt-in, overrides)
 * - list commands (one spawn per entry, aggregate result)
 * - empty/whitespace command guard
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeSpawn, makeSpawnResult, withDebugSpy, withInfoSpy } from "@test/helpers";
import { _qualityRunnerDeps, runQualityCommand } from "@/quality/runner";

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

// ---------------------------------------------------------------------------
// origin gating — harness vs agent-tool console semantics
// ---------------------------------------------------------------------------
// The quality runner has two callers with very different console semantics:
//
//  - the harness's own deterministic ops (lintCheckOp, typecheckCheckOp, the
//    finish gates, `nax setup`), which run a gate once and whose outcome the
//    operator must see; and
//  - the agent's `RunCommand` coding tool (src/tools/run-command.ts), which is
//    the agent's own iteration loop. On acpx that loop runs inside the spawned
//    agent process and nax never observes it; on the native path it comes back
//    through this runner. In one observed run 283 of 289 invocations (98%) were
//    agent-tool calls, and a failing lint among them is normal TDD red, not a
//    harness fault.
//
// So agent-tool records are demoted to debug: still written to the JSONL (the
// file sink writes every level), filtered off the console by the formatter.

describe("runQualityCommand — origin gating", () => {
  let originalSpawn: typeof _qualityRunnerDeps.spawn;

  beforeEach(() => {
    originalSpawn = _qualityRunnerDeps.spawn;
    _qualityRunnerDeps.spawn = makeSpawn(() => "ok").spawn;
  });

  afterEach(() => {
    _qualityRunnerDeps.spawn = originalSpawn;
  });

  test("harness origin is the default and logs at info", async () => {
    await withInfoSpy(async (infoSpy) => {
      await runQualityCommand({
        commandName: "lint",
        command: "bun run lint",
        workdir: "/tmp/project",
        storyId: "US-001",
      });

      const quality = infoSpy.mock.calls.filter((c) => c[0] === "quality");
      expect(quality.map((c) => c[1])).toEqual(["Running lint", "lint completed"]);
    });
  });

  test("explicit harness origin logs at info", async () => {
    await withInfoSpy(async (infoSpy) => {
      await runQualityCommand({
        commandName: "typecheck",
        command: "bun run typecheck",
        workdir: "/tmp/project",
        origin: "harness",
      });

      expect(infoSpy.mock.calls.filter((c) => c[0] === "quality")).toHaveLength(2);
    });
  });

  test("agent-tool origin emits no info records", async () => {
    await withInfoSpy(async (infoSpy) => {
      await runQualityCommand({
        commandName: "lint",
        command: "bun run lint",
        workdir: "/tmp/project",
        origin: "agent-tool",
      });

      expect(infoSpy.mock.calls.filter((c) => c[0] === "quality")).toHaveLength(0);
    });
  });

  test("agent-tool origin still records both lines at debug", async () => {
    await withDebugSpy(async (debugSpy) => {
      await runQualityCommand({
        commandName: "testScoped",
        command: "bun test foo.test.ts",
        workdir: "/tmp/project",
        origin: "agent-tool",
      });

      const quality = debugSpy.mock.calls.filter((c) => c[0] === "quality");
      expect(quality.map((c) => c[1])).toEqual(["Running testScoped", "testScoped completed"]);
    });
  });

  test("agent-tool debug records keep their structured payload", async () => {
    await withDebugSpy(async (debugSpy) => {
      await runQualityCommand({
        commandName: "lint",
        command: "bun run lint",
        workdir: "/tmp/project",
        storyId: "US-007",
        origin: "agent-tool",
      });

      const completed = debugSpy.mock.calls.find((c) => c[1] === "lint completed");
      const data = completed?.[2] as Record<string, unknown>;
      expect(data.storyId).toBe("US-007");
      expect(data.commandName).toBe("lint");
      expect(data.exitCode).toBe(0);
    });
  });

  test("a failing agent-tool command is not promoted off debug", async () => {
    _qualityRunnerDeps.spawn = makeSpawn(() => ({ stdout: "", stderr: "boom", exitCode: 1 })).spawn;

    await withInfoSpy(async (infoSpy) => {
      const result = await runQualityCommand({
        commandName: "lint",
        command: "bun run lint",
        workdir: "/tmp/project",
        origin: "agent-tool",
      });

      expect(result.success).toBe(false);
      expect(infoSpy.mock.calls.filter((c) => c[0] === "quality")).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// env stripping — secrets, AGENT=1 opt-in, overrides
// ---------------------------------------------------------------------------

describe("runQualityCommand env stripping", () => {
  let originalSpawn: typeof _qualityRunnerDeps.spawn;
  // A developer (or agent) running the suite from an agent shell already has
  // CLAUDECODE/AGENT exported, which would satisfy the marker check and make
  // these assertions pass or fail for reasons unrelated to the code. Control
  // them explicitly.
  const markers = ["CLAUDECODE", "REPL_ID", "AGENT"] as const;
  let savedMarkers: Record<string, string | undefined>;

  beforeEach(() => {
    originalSpawn = _qualityRunnerDeps.spawn;
    savedMarkers = Object.fromEntries(markers.map((m) => [m, process.env[m]]));
    for (const m of markers) delete process.env[m];
  });

  afterEach(() => {
    _qualityRunnerDeps.spawn = originalSpawn;
    for (const [m, v] of Object.entries(savedMarkers)) {
      if (v === undefined) delete process.env[m];
      else process.env[m] = v;
    }
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.MY_VAR;
  });

  test("removes configured secret vars from the spawned env", async () => {
    process.env.AWS_SECRET_ACCESS_KEY = "leak-me";
    const { spawn, lastEnv } = makeSpawn();
    _qualityRunnerDeps.spawn = spawn;

    await runQualityCommand({
      commandName: "lint",
      command: "true",
      workdir: "/tmp",
      stripEnvVars: ["AWS_SECRET_ACCESS_KEY"],
    });

    expect(lastEnv().AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  // nax#agent-output: bun test (and other agent-aware runners) emit
  // failures-only output when they see this marker. The verification executor
  // applies the same rule — the two spawn sites must not drift.
  test("opts the child into agent-friendly output with AGENT=1", async () => {
    const { spawn, lastEnv } = makeSpawn();
    _qualityRunnerDeps.spawn = spawn;

    await runQualityCommand({ commandName: "lint", command: "true", workdir: "/tmp" });

    expect(lastEnv().AGENT).toBe("1");
  });

  test("an explicit strip of AGENT is not silently undone", async () => {
    const { spawn, lastEnv } = makeSpawn();
    _qualityRunnerDeps.spawn = spawn;

    await runQualityCommand({
      commandName: "lint",
      command: "true",
      workdir: "/tmp",
      stripEnvVars: ["AGENT"],
    });

    expect(lastEnv().AGENT).toBeUndefined();
  });

  test("passes env unchanged when no stripEnvVars provided", async () => {
    process.env.MY_VAR = "keep-me";
    const { spawn, lastEnv } = makeSpawn();
    _qualityRunnerDeps.spawn = spawn;

    await runQualityCommand({
      commandName: "lint",
      command: "true",
      workdir: "/tmp",
    });

    expect(lastEnv().MY_VAR).toBe("keep-me");
  });

  test("strips multiple vars when multiple are configured", async () => {
    process.env.AWS_SECRET_ACCESS_KEY = "secret1";
    process.env.MY_VAR = "secret2";
    const { spawn, lastEnv } = makeSpawn();
    _qualityRunnerDeps.spawn = spawn;

    await runQualityCommand({
      commandName: "lint",
      command: "true",
      workdir: "/tmp",
      stripEnvVars: ["AWS_SECRET_ACCESS_KEY", "MY_VAR"],
    });

    expect(lastEnv().AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(lastEnv().MY_VAR).toBeUndefined();
  });

  test("env override still applies after stripping", async () => {
    process.env.AWS_SECRET_ACCESS_KEY = "leak-me";
    const { spawn, lastEnv } = makeSpawn();
    _qualityRunnerDeps.spawn = spawn;

    await runQualityCommand({
      commandName: "lint",
      command: "true",
      workdir: "/tmp",
      stripEnvVars: ["AWS_SECRET_ACCESS_KEY"],
      env: { OVERRIDE_VAR: "override-value" },
    });

    expect(lastEnv().AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(lastEnv().OVERRIDE_VAR).toBe("override-value");
  });
});

// ---------------------------------------------------------------------------
// list commands — one spawn per entry, aggregate result
// ---------------------------------------------------------------------------

const realSpawn = _qualityRunnerDeps.spawn;
afterEach(() => {
  _qualityRunnerDeps.spawn = realSpawn;
});

/** Script each shell command's exit code; returns the stub for call assertions. */
function stubSpawn(exitCodeFor: (command: string) => number) {
  const stub = makeSpawn(({ cmd }) => {
    const command = cmd[2] ?? "";
    return { exitCode: exitCodeFor(command), stdout: `output of ${command}` };
  });
  _qualityRunnerDeps.spawn = stub.spawn;
  return stub;
}

/** The shell command of each recorded spawn, in order. */
function commandsRun(stub: ReturnType<typeof stubSpawn>): string[] {
  return stub.calls.map((call) => call.cmd[2] ?? "");
}

describe("runQualityCommand with a list", () => {
  test("runs every entry even after one fails", async () => {
    const stub = stubSpawn((c) => (c === "step-a" ? 1 : 0));
    await runQualityCommand({
      commandName: "typecheck",
      command: ["step-a", "step-b", "step-c"],
      workdir: "/tmp",
    });
    expect(commandsRun(stub)).toEqual(["step-a", "step-b", "step-c"]);
  });

  test("aggregates failure across entries", async () => {
    stubSpawn((c) => (c === "step-b" ? 2 : 0));
    const result = await runQualityCommand({
      commandName: "typecheck",
      command: ["step-a", "step-b"],
      workdir: "/tmp",
    });
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(2);
  });

  test("carries output from every entry", async () => {
    stubSpawn(() => 0);
    const result = await runQualityCommand({
      commandName: "typecheck",
      command: ["step-a", "step-b"],
      workdir: "/tmp",
    });
    expect(result.output).toContain("output of step-a");
    expect(result.output).toContain("output of step-b");
  });

  test("succeeds when every entry succeeds", async () => {
    stubSpawn(() => 0);
    const result = await runQualityCommand({
      commandName: "lint",
      command: ["step-a", "step-b"],
      workdir: "/tmp",
    });
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  test("a plain string still spawns exactly once", async () => {
    const stub = stubSpawn(() => 0);
    const result = await runQualityCommand({
      commandName: "lint",
      command: "only-one",
      workdir: "/tmp",
    });
    expect(commandsRun(stub)).toEqual(["only-one"]);
    expect(result.command).toBe("only-one");
  });

  test("preserves a plain string command byte-for-byte", async () => {
    const stub = stubSpawn(() => 0);
    const command = "  only-one  ";
    const result = await runQualityCommand({ commandName: "lint", command, workdir: "/tmp" });
    expect(commandsRun(stub)).toEqual([command]);
    expect(result.command).toBe(command);
  });

  test("an empty list is treated as an undeclared command", async () => {
    const stub = stubSpawn(() => 0);
    const result = await runQualityCommand({ commandName: "build", command: [], workdir: "/tmp" });
    expect(stub.calls).toHaveLength(0);
    expect(result.success).toBe(false);
    expect(result.output).toContain("empty command");
  });
});

// ---------------------------------------------------------------------------
// empty-command guard
// ---------------------------------------------------------------------------

describe("runQualityCommand empty-command guard", () => {
  test("returns failure (does not spawn) for an empty command", async () => {
    const result = await runQualityCommand({ commandName: "lint", command: "", workdir: "/tmp", storyId: "US-001" });
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(-1);
    expect(result.output).toContain("empty command");
  });

  test("returns failure for a whitespace-only command", async () => {
    const result = await runQualityCommand({ commandName: "lint", command: "   ", workdir: "/tmp", storyId: "US-001" });
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(-1);
  });
});
