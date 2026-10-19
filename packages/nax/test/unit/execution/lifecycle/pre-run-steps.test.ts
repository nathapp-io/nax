/**
 * US-003 — `runPreRunSteps`: the sequential, fail-closed runner for
 * `execution.preRun` (blocking host-side setup commands).
 *
 * Every step runs through the module's injectable `_preRunDeps` seam, so these
 * tests observe the trust check, the spawn call and the ordering between them
 * without touching a real process. `_preRunDeps.now` is driven by a virtual
 * clock (+50 ms per read) so `durationMs` is asserted exactly rather than
 * bounded.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { assertNaxError, withDepsRestore } from "@test/helpers";
import { NaxError } from "@/errors";
import { _preRunDeps, runPreRunSteps } from "@/execution/lifecycle/pre-run-steps";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";
import type { TestExecutionResult } from "@/verification";

const WORKDIR = "/tmp/nax-pre-run-steps";

interface ExecCall {
  command: string;
  timeoutSeconds: number;
  env: Record<string, string | undefined> | undefined;
  options: { cwd?: string } | undefined;
}

const execCalls: ExecCall[] = [];
const trustCalls: Array<{ path: string; surface: string }> = [];
const callOrder: string[] = [];
let results: TestExecutionResult[] = [];
let virtualNow = 0;
let logs: LogEntry[] = [];

function ok(overrides: Partial<TestExecutionResult> = {}): TestExecutionResult {
  return { success: true, timeout: false, exitCode: 0, output: "", countsTowardEscalation: true, ...overrides };
}

/** The rejection `runPreRunSteps` produced, failing the test if it resolved. */
async function rejectionOf(run: Promise<void>): Promise<NaxError> {
  const caught = await run.then(
    () => undefined,
    (err: unknown) => err,
  );
  assertNaxError(caught, "runPreRunSteps rejection");
  return caught;
}

beforeEach(() => {
  resetLogger();
  logs = [];
  initLogger({ level: "debug" });
  addSink((entry) => logs.push(entry));
});

afterEach(() => {
  resetLogger();
});

describe("runPreRunSteps", () => {
  withDepsRestore(_preRunDeps);

  beforeEach(() => {
    execCalls.length = 0;
    trustCalls.length = 0;
    callOrder.length = 0;
    results = [];
    virtualNow = 0;
    _preRunDeps.now = () => (virtualNow += 50);
    _preRunDeps.assertTrusted = async (path, surface) => {
      trustCalls.push({ path, surface });
      callOrder.push("assertTrusted");
    };
    _preRunDeps.executeWithTimeout = async (command, timeoutSeconds, env, options) => {
      execCalls.push({ command, timeoutSeconds, env, options });
      callOrder.push(`execute:${command}`);
      return results.shift() ?? ok();
    };
  });

  test("AC-14: no steps is a no-op — no trust check and no spawn", async () => {
    await runPreRunSteps({ steps: [], workdir: WORKDIR });

    expect(trustCalls).toEqual([]);
    expect(execCalls).toEqual([]);
  });

  test("AC-5: runs every step once, in configured order, with the step's timeout and cwd: workdir", async () => {
    results = [ok(), ok()];

    await runPreRunSteps({
      steps: [
        { command: "docker compose up -d --wait", timeoutSeconds: 180 },
        { command: "./scripts/seed-test-db.sh", timeoutSeconds: 300 },
      ],
      workdir: WORKDIR,
    });

    expect(execCalls).toEqual([
      { command: "docker compose up -d --wait", timeoutSeconds: 180, env: undefined, options: { cwd: WORKDIR } },
      { command: "./scripts/seed-test-db.sh", timeoutSeconds: 300, env: undefined, options: { cwd: WORKDIR } },
    ]);
  });

  test("AC-10: checks trust for the workdir as the 'pre-run' surface before spawning", async () => {
    await runPreRunSteps({ steps: [{ command: "up", timeoutSeconds: 5 }], workdir: WORKDIR });

    expect(trustCalls).toEqual([{ path: WORKDIR, surface: "pre-run" }]);
    expect(callOrder).toEqual(["assertTrusted", "execute:up"]);
  });

  test("AC-11: a PROJECT_UNTRUSTED refusal propagates and the command is never spawned", async () => {
    const refusal = new NaxError("[trust] refusing to run pre-run in an untrusted project", "PROJECT_UNTRUSTED", {
      stage: "trust",
      surface: "pre-run",
    });
    _preRunDeps.assertTrusted = async () => {
      throw refusal;
    };

    const err = await rejectionOf(runPreRunSteps({ steps: [{ command: "up", timeoutSeconds: 5 }], workdir: WORKDIR }));

    expect(err).toBe(refusal);
    expect(err.code).toBe("PROJECT_UNTRUSTED");
    expect(execCalls).toEqual([]);
  });

  test("AC-6: a non-zero exit throws PRE_RUN_FAILED naming the command and the exit code", async () => {
    results = [ok({ success: false, exitCode: 3, output: "boom" })];

    const err = await rejectionOf(
      runPreRunSteps({ steps: [{ command: "deploy.sh", timeoutSeconds: 30 }], workdir: WORKDIR }),
    );

    expect(err.code).toBe("PRE_RUN_FAILED");
    expect(err.message).toContain("deploy.sh");
    expect(err.message).toContain("exit 3");
  });

  test("AC-7: a failure with no exit code is reported as exit unknown", async () => {
    results = [ok({ success: false, exitCode: undefined, output: "killed" })];

    const err = await rejectionOf(
      runPreRunSteps({ steps: [{ command: "deploy.sh", timeoutSeconds: 30 }], workdir: WORKDIR }),
    );

    expect(err.code).toBe("PRE_RUN_FAILED");
    expect(err.message).toContain("deploy.sh");
    expect(err.message).toContain("exit unknown");
  });

  test("AC-9: a timeout throws PRE_RUN_FAILED naming the command and the budget", async () => {
    results = [ok({ success: false, timeout: true, exitCode: undefined, output: "still starting" })];

    const err = await rejectionOf(runPreRunSteps({ steps: [{ command: "up", timeoutSeconds: 5 }], workdir: WORKDIR }));

    expect(err.code).toBe("PRE_RUN_FAILED");
    expect(err.message).toContain("up");
    expect(err.message).toContain("timed out after 5s");
  });

  test("AC-8: a failing first step stops the run — the second step is never spawned", async () => {
    results = [ok({ success: false, exitCode: 1 })];

    const err = await rejectionOf(
      runPreRunSteps({
        steps: [
          { command: "first", timeoutSeconds: 30 },
          { command: "second", timeoutSeconds: 30 },
        ],
        workdir: WORKDIR,
      }),
    );

    expect(err.code).toBe("PRE_RUN_FAILED");
    expect(execCalls.map((call) => call.command)).toEqual(["first"]);
  });

  test.each([
    ["a non-zero exit", ok({ success: false, exitCode: 1 })],
    ["a timeout", ok({ success: false, timeout: true, exitCode: undefined })],
  ])("AC-25: %s is not retried", async (_label, failingResult) => {
    results = [failingResult];

    await rejectionOf(runPreRunSteps({ steps: [{ command: "up", timeoutSeconds: 5 }], workdir: WORKDIR }));

    expect(execCalls).toHaveLength(1);
  });

  test("AC-21: the thrown error carries { stage, command, exitCode } context", async () => {
    results = [ok({ success: false, exitCode: 3, output: "boom" })];

    const err = await rejectionOf(
      runPreRunSteps({ steps: [{ command: "deploy.sh", timeoutSeconds: 30 }], workdir: WORKDIR }),
    );

    expect(err.context).toEqual({ stage: "execution", command: "deploy.sh", exitCode: 3 });
  });

  test("AC-22: the timeout error carries the same context shape", async () => {
    results = [ok({ success: false, timeout: true, exitCode: undefined, output: "" })];

    const err = await rejectionOf(
      runPreRunSteps({ steps: [{ command: "deploy.sh", timeoutSeconds: 30 }], workdir: WORKDIR }),
    );

    expect(err.context).toEqual({ stage: "execution", command: "deploy.sh", exitCode: undefined });
    expect(Object.keys(err.context ?? {}).sort()).toEqual(["command", "exitCode", "stage"]);
    expect(err.context?.exitCode).toBeUndefined();
  });

  test("AC-12: a successful step logs 'Pre-run step completed' at info with storyId '_run' and its command/exitCode/durationMs", async () => {
    await runPreRunSteps({ steps: [{ command: "true", timeoutSeconds: 30 }], workdir: WORKDIR });

    const entry = logs.find((e) => e.message === "Pre-run step completed");
    expect(entry).toBeDefined();
    expect(entry?.level).toBe("info");
    expect(entry?.stage).toBe("execution");
    expect(Object.keys(entry?.data ?? {})[0]).toBe("storyId");
    expect(entry?.data).toEqual({ storyId: "_run", command: "true", exitCode: 0, durationMs: 50 });
  });

  test("AC-13: a failing step logs 'Pre-run step failed' at error with storyId '_run', command, exitCode, timedOut and outputTail", async () => {
    results = [ok({ success: false, exitCode: 3, output: "line one\nline two" })];

    await rejectionOf(runPreRunSteps({ steps: [{ command: "deploy.sh", timeoutSeconds: 30 }], workdir: WORKDIR }));

    const entry = logs.find((e) => e.message === "Pre-run step failed");
    expect(entry).toBeDefined();
    expect(entry?.level).toBe("error");
    expect(entry?.stage).toBe("execution");
    expect(Object.keys(entry?.data ?? {})[0]).toBe("storyId");
    expect(entry?.data).toEqual({
      storyId: "_run",
      command: "deploy.sh",
      exitCode: 3,
      timedOut: false,
      durationMs: 50,
      outputTail: "line one\nline two",
    });
  });

  test("the log tail keeps only the last 2000 characters of output", async () => {
    results = [ok({ success: false, exitCode: 1, output: `${"x".repeat(2500)}TAIL` })];

    await rejectionOf(runPreRunSteps({ steps: [{ command: "up", timeoutSeconds: 5 }], workdir: WORKDIR }));

    const data = logs.find((e) => e.message === "Pre-run step failed")?.data;
    expect(data?.outputTail).toHaveLength(2000);
    expect(data?.outputTail).toEndWith("TAIL");
  });

  test("a timed-out step logs timedOut: true with the configured budget", async () => {
    results = [ok({ success: false, timeout: true, exitCode: undefined, output: "still starting" })];

    await rejectionOf(runPreRunSteps({ steps: [{ command: "up", timeoutSeconds: 5 }], workdir: WORKDIR }));

    const entry = logs.find((e) => e.message === "Pre-run step failed");
    expect(entry?.data).toEqual({
      storyId: "_run",
      command: "up",
      timedOut: true,
      timeoutSeconds: 5,
      durationMs: 50,
      outputTail: "still starting",
    });
  });
});
