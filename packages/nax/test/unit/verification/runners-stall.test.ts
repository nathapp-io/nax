/**
 * Verification runners — interruption evidence in list aggregation (US-004).
 *
 * A command list keeps its historical raw aggregation: `status`, `exitCode` and
 * `error` come from the first unsuccessful entry, `success` is "every entry
 * succeeded", `countsTowardEscalation` is the any-entry `some`, and the output
 * and pass/fail counts are unchanged. Interruption evidence is carried
 * *independently* of that aggregate: `stopReason` is the first detector reason in
 * command order, and its presence — not the aggregate `status` — is what tells a
 * consumer the list was stopped rather than merely failing.
 *
 * Driven through the real `scoped()` / `regression()` entry points with a spawn
 * stub whose stalled child repeats a line while its exit never settles, so the
 * detector — not the wall deadline — ends that entry.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  makeSpawn,
  makeSpawnResult,
  type SpawnResult,
  type SpawnStub,
  STALL_REPEAT_LINE,
  stalledProc,
} from "@test/helpers";
import { createGateStallMonitor, type GateStallPolicy, type GateStopReason } from "@/utils/gate-stall";
import type { VerificationGateOptions } from "@/verification";
import { _executorDeps, _regressionRunnerDeps, regression, scoped } from "@/verification";

const THRESHOLD = 3;
const REPEATED_LINE = STALL_REPEAT_LINE;
const GRACE_MS = 5;
const DRAIN_MS = 20;

/** The repetition policy every list below opts into; silence stays disabled. */
const POLICY: GateStallPolicy = { repeatedLineThreshold: THRESHOLD, silenceTimeoutSeconds: 0 };

const STOP_ON_STDOUT: GateStopReason = {
  kind: "repeated-output",
  stream: "stdout",
  count: THRESHOLD,
  threshold: THRESHOLD,
};
const STOP_ON_STDERR: GateStopReason = {
  kind: "repeated-output",
  stream: "stderr",
  count: THRESHOLD,
  threshold: THRESHOLD,
};

/** How one list entry behaves when the runner spawns it. */
type Behaviour = "pass" | "fail" | "environmental" | "stall-stdout" | "stall-stderr";

function procFor(behaviour: Behaviour): SpawnResult {
  switch (behaviour) {
    case "pass":
      return makeSpawnResult({ stdout: "Tests: 1 passed", exitCode: 0 });
    case "fail":
      return makeSpawnResult({ stdout: "Tests: 1 failed, 0 passed", exitCode: 1 });
    case "environmental":
      // Every test reported as passing yet the runner exited non-zero.
      return makeSpawnResult({ stdout: "Tests: 5 passed", exitCode: 1 });
    case "stall-stdout":
      return stalledProc("stdout", THRESHOLD);
    case "stall-stderr":
      return stalledProc("stderr", THRESHOLD);
  }
}

/** Install a spawn stub keyed by the command the runner actually executes. */
function stubSpawn(specs: Record<string, Behaviour>): SpawnStub {
  const stub = makeSpawn(({ cmd }) => {
    const command = cmd[2] ?? "";
    const behaviour = specs[command];
    if (behaviour === undefined) throw new Error(`[test] unexpected command "${command}"`);
    return procFor(behaviour);
  });
  _executorDeps.spawn = stub.spawn;
  return stub;
}

interface MonitorSpy {
  readonly policies: GateStallPolicy[];
}

function spyOnMonitor(spy: MonitorSpy): void {
  _executorDeps.createGateStallMonitor = (options) => {
    spy.policies.push(options.policy);
    return createGateStallMonitor(options);
  };
}

function listOptions(command: string[], overrides: Partial<VerificationGateOptions> = {}): VerificationGateOptions {
  return {
    workdir: "/tmp/does-not-matter",
    command,
    // The detector stops a repeating child within a few microtasks of spawn, so
    // this wall deadline is only a backstop for the pre-change RED run.
    timeoutSeconds: 1,
    gracePeriodMs: GRACE_MS,
    drainTimeoutMs: DRAIN_MS,
    stallDetection: POLICY,
    ...overrides,
  };
}

/**
 * `scoped` and `regression` share one verification core; both are parametrised
 * below so a list rule cannot hold on one and not the other.
 */
const RUNNERS = [
  ["scoped", scoped],
  ["regression", regression],
] as const;

const originalExecutorDeps = { ..._executorDeps };
const originalSleep = _regressionRunnerDeps.sleep;

beforeEach(() => {
  // Neither runner may wait out a real detector lane here: kill is stubbed and
  // regression's agent-cleanup sleep is replaced.
  _executorDeps.killProcessGroup = () => true;
  _regressionRunnerDeps.sleep = async () => {};
});

afterEach(() => {
  Object.assign(_executorDeps, originalExecutorDeps);
  _regressionRunnerDeps.sleep = originalSleep;
});

describe("verification command lists after a detector stop (US-004)", () => {
  // AC-1
  test.each(RUNNERS)("%s runs every entry in command order after a detector stop", async (_name, run) => {
    const stub = stubSpawn({ "stall-first": "stall-stdout", "run-after": "pass" });

    const result = await run(listOptions(["stall-first", "run-after"]));

    expect(stub.calls.map((call) => call.cmd[2])).toEqual(["stall-first", "run-after"]);
    expect(result.stopReason).toEqual(STOP_ON_STDOUT);
  });

  // AC-2
  test.each(RUNNERS)(
    "%s keeps the first failing entry's status and exitCode when a later entry stops",
    async (_name, run) => {
      stubSpawn({ "fails-first": "fail", "stalls-after": "stall-stdout" });

      const result = await run(listOptions(["fails-first", "stalls-after"]));

      // The ordinary failure came first, so the aggregate still reads as a code failure…
      expect(result.status).toBe("TEST_FAILURE");
      expect(result.exitCode).toBe(1);
      // No error text on a plain TEST_FAILURE — nothing invented by the stopped entry.
      expect(result.error).toBeUndefined();
      expect(result.failCount).toBe(1);
      // …while the interruption evidence rides alongside it, so this mixed list can
      // never be mistaken for an ordinary code failure.
      expect(result.stopReason).toEqual(STOP_ON_STDOUT);
    },
  );

  // AC-2 — the error channel belongs to the first failing entry, not the stopped one.
  test.each(RUNNERS)("%s carries the first failing entry's error when it has one", async (_name, run) => {
    stubSpawn({ "fails-first": "environmental", "stalls-after": "stall-stdout" });

    const result = await run(listOptions(["fails-first", "stalls-after"]));

    expect(result.status).toBe("ENVIRONMENTAL_FAILURE");
    expect(result.error).toContain("ENVIRONMENTAL_FAILURE");
    // The stopped entry's own EXECUTION_STALLED message must not replace it.
    expect(result.error).not.toContain("EXECUTION_STALLED");
  });

  // AC-3
  test.each(RUNNERS)("%s keeps the first entry's status and error when it stops", async (_name, run) => {
    stubSpawn({ "stalls-first": "stall-stdout", "fails-after": "fail" });

    const result = await run(listOptions(["stalls-first", "fails-after"]));

    expect(result.status).toBe("TIMEOUT");
    expect(result.error).toContain("EXECUTION_STALLED");
    // The stopped lane carries no exit code, so the aggregate keeps its historical
    // default rather than borrowing the later failure's exit code.
    expect(result.exitCode).toBe(0);
    // Both entries' output is still aggregated.
    expect(result.output).toContain(REPEATED_LINE);
    expect(result.output).toContain("Tests: 1 failed");
  });

  // AC-4
  test.each(RUNNERS)("%s exposes the detector reason of the stopped entry", async (_name, run) => {
    stubSpawn({ "stalls-first": "stall-stderr", "fails-after": "fail" });
    expect((await run(listOptions(["stalls-first", "fails-after"]))).stopReason).toEqual(STOP_ON_STDERR);

    stubSpawn({ "fails-first": "fail", "stalls-after": "stall-stdout" });
    expect((await run(listOptions(["fails-first", "stalls-after"]))).stopReason).toEqual(STOP_ON_STDOUT);
  });

  // AC-4 — "first in command order" is observable when more than one entry stops.
  test.each(RUNNERS)("%s keeps the first detector reason in command order", async (_name, run) => {
    stubSpawn({ "stalls-stdout": "stall-stdout", "stalls-stderr": "stall-stderr" });

    const result = await run(listOptions(["stalls-stdout", "stalls-stderr"]));

    expect(result.stopReason).toEqual(STOP_ON_STDOUT);
  });

  // AC-5
  test.each(RUNNERS)("%s keeps any-entry escalation semantics in both stop/failure orders", async (_name, run) => {
    stubSpawn({ "fails-first": "fail", "stalls-after": "stall-stdout" });
    const failureFirst = await run(listOptions(["fails-first", "stalls-after"]));
    expect(failureFirst.countsTowardEscalation).toBe(true);
    expect(failureFirst.stopReason).toEqual(STOP_ON_STDOUT);

    // The first entry does not escalate; a later one does — `some`, not "first entry".
    stubSpawn({ "stalls-first": "stall-stdout", "fails-after": "fail" });
    const stopFirst = await run(listOptions(["stalls-first", "fails-after"]));
    expect(stopFirst.countsTowardEscalation).toBe(true);
    expect(stopFirst.stopReason).toEqual(STOP_ON_STDOUT);

    // Nothing escalates when every stopped entry declines to.
    stubSpawn({ "stalls-stdout": "stall-stdout", "stalls-stderr": "stall-stderr" });
    const allStopped = await run(listOptions(["stalls-stdout", "stalls-stderr"]));
    expect(allStopped.countsTowardEscalation).toBe(false);
    expect(allStopped.stopReason).toEqual(STOP_ON_STDOUT);
  });

  // AC-6
  test.each(RUNNERS)("%s carries no stopReason when no entry was stopped", async (_name, run) => {
    stubSpawn({ "fails-first": "fail", "passes-after": "pass" });

    const result = await run(listOptions(["fails-first", "passes-after"]));

    expect(result.stopReason).toBeUndefined();
    expect(Object.hasOwn(result, "stopReason")).toBe(false);
  });

  // AC-7
  test.each(RUNNERS)("%s passes its configured stallDetection into the executor", async (_name, run) => {
    const spy: MonitorSpy = { policies: [] };
    spyOnMonitor(spy);
    stubSpawn({ "passes-now": "pass" });

    await run(listOptions(["passes-now"], { stallDetection: { repeatedLineThreshold: 7, silenceTimeoutSeconds: 11 } }));

    expect(spy.policies).toEqual([{ repeatedLineThreshold: 7, silenceTimeoutSeconds: 11 }]);
  });

  // AC-7 — an absent policy creates no monitor, so no detector can stop the run.
  test.each(RUNNERS)("%s passes nothing when no stallDetection is configured", async (_name, run) => {
    const spy: MonitorSpy = { policies: [] };
    spyOnMonitor(spy);
    stubSpawn({ "passes-now": "pass" });

    await run(listOptions(["passes-now"], { stallDetection: undefined }));

    expect(spy.policies).toEqual([]);
  });

  // AC-8
  test.each(RUNNERS)("%s retains status TIMEOUT and no escalation on a detector interruption", async (_name, run) => {
    stubSpawn({ "stalls-only": "stall-stderr" });

    const result = await run(listOptions(["stalls-only"]));

    expect(result.status).toBe("TIMEOUT");
    expect(result.success).toBe(false);
    expect(result.countsTowardEscalation).toBe(false);
    expect(result.stopReason).toEqual(STOP_ON_STDERR);
  });
});
