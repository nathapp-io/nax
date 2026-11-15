/**
 * `fullSuiteGateOp` — stop evidence and accept-on-timeout (US-004).
 *
 * The gate derives its internal timeout evidence from the same predicate the
 * scoped op uses — `status === "TIMEOUT" || stopReason !== undefined` — so a
 * command list that reports its first failing entry's ordinary `TEST_FAILURE`
 * while one entry was stopped still reaches the timeout branch. The existing
 * `acceptOnTimeout` translation then decides `passed-on-timeout` versus `timeout`,
 * and both forms carry the detector reason. The gate-context stall policy is
 * forwarded to `regression` for the run.
 *
 * Split from `full-suite-gate.test.ts` by concern to keep both files within the
 * test-size target.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type DeepPartial,
  makeMockCallContext,
  makeMockRuntime,
  makeNaxConfig,
  makeSpawn,
  makeStory,
  stalledProc,
} from "@test/helpers";
import type { ConfigSelector, NaxConfig } from "@/config";
import type { CallContext, FullSuiteGateDeps, FullSuiteGateInput, FullSuiteGateOutput } from "@/operations";
import { _fullSuiteGateDeps, fullSuiteGateOp } from "@/operations";
import type { FullSuiteGateContext } from "@/operations/full-suite-gate";
import type { PackageView } from "@/runtime";
import { createGateStallMonitor, type GateStallPolicy, type GateStopReason } from "@/utils/gate-stall";
import { _executorDeps, _regressionRunnerDeps } from "@/verification";

/** The per-gate policy the op must forward to `regression`. */
const GATE_POLICY: GateStallPolicy = { repeatedLineThreshold: 4, silenceTimeoutSeconds: 0 };

const STOP_REASON: GateStopReason = { kind: "repeated-output", stream: "stdout", count: 4, threshold: 4 };

const INPUT: FullSuiteGateInput = { story: makeStory({ id: "US-004" }), workdir: "/tmp" };

/** What the gate's `runTests` dep answers. */
type RunTestsResult = Awaited<ReturnType<FullSuiteGateDeps["runTests"]>>;

function ctxWithConfig(overrides: DeepPartial<NaxConfig> = {}): CallContext {
  const config = makeNaxConfig(overrides);
  const runtime = makeMockRuntime({ config });
  const packageView: PackageView = {
    packageDir: "packages/app",
    relativeFromRoot: "packages/app",
    repoRoot: "/repo",
    hasOverride: false,
    config,
    select: <C>(selector: ConfigSelector<C>) => selector.select(config),
  };
  return makeMockCallContext({ runtime, packageView, storyId: "US-004" });
}

function gateContext(config: NaxConfig, testCmd: FullSuiteGateContext["testCmd"]): FullSuiteGateContext {
  // The full-suite deadline doubles as the backstop for the pre-change RED run; the
  // detector stops a repeating child within a few microtasks of spawn.
  return { config, testCmd, fullSuiteTimeout: 1, cmdWorkdir: "/tmp" };
}

/** Deps whose `runTests` is the real production implementation. */
function realRunDeps(config: NaxConfig, testCmd: FullSuiteGateContext["testCmd"]): FullSuiteGateDeps {
  return {
    resolveGateContext: async () => gateContext(config, testCmd),
    runTests: _fullSuiteGateDeps.runTests,
  };
}

/** A controlled run result: one ordinary test failure, no timeout evidence of its own. */
function failingRun(extra: Partial<RunTestsResult> = {}): RunTestsResult {
  return {
    passed: false,
    failed: 1,
    output: "Tests: 1 failed, 0 passed",
    parsedSummary: {
      passed: 0,
      failed: 1,
      failures: [{ file: "test/a.test.ts", testName: "test A", error: "err A", stackTrace: [] }],
    },
    timedOut: false,
    command: "bun test",
    ...extra,
  };
}

/** Deps with a controlled `runTests` result, for the aggregate shapes one command cannot produce. */
function controlledDeps(config: NaxConfig, result: RunTestsResult): FullSuiteGateDeps {
  return {
    resolveGateContext: async () => gateContext(config, "bun test"),
    runTests: async () => result,
  };
}

/** Record the policy each spawned gate command was armed with. */
function spyOnPolicies(): GateStallPolicy[] {
  const policies: GateStallPolicy[] = [];
  _executorDeps.createGateStallMonitor = (options) => {
    policies.push(options.policy);
    return createGateStallMonitor(options);
  };
  return policies;
}

const originalExecutorDeps = { ..._executorDeps };
const originalSleep = _regressionRunnerDeps.sleep;

beforeEach(() => {
  _executorDeps.killProcessGroup = () => true;
  _executorDeps.spawn = makeSpawn(() => ({ stdout: "Tests: 1 passed", exitCode: 0 })).spawn;
  _regressionRunnerDeps.sleep = async () => {};
});

afterEach(() => {
  Object.assign(_executorDeps, originalExecutorDeps);
  _regressionRunnerDeps.sleep = originalSleep;
});

describe("fullSuiteGateOp — stall policy forwarding (US-004)", () => {
  // AC-13
  test("forwards the gate-context stallDetection to regression", async () => {
    const policies = spyOnPolicies();
    const config = makeNaxConfig({ quality: { stallDetection: GATE_POLICY } });

    const out = await fullSuiteGateOp.execute(INPUT, ctxWithConfig(), realRunDeps(config, "bun test"));

    expect(out.status).toBe("passed");
    expect(policies).toEqual([GATE_POLICY]);
  });

  // AC-13 — a list command is run entry by entry, and each entry is armed.
  test("forwards the policy to every command in a list the gate runs", async () => {
    const policies = spyOnPolicies();
    const config = makeNaxConfig({ quality: { stallDetection: GATE_POLICY } });

    await fullSuiteGateOp.execute(INPUT, ctxWithConfig(), realRunDeps(config, ["first", "second"]));

    expect(policies).toEqual([GATE_POLICY, GATE_POLICY]);
  });
});

describe("fullSuiteGateOp — timeout evidence from a stop reason (US-004)", () => {
  // AC-14
  test("derives timeout evidence from the list stop reason when the status is a test failure", async () => {
    const config = makeNaxConfig({ execution: { regressionGate: { acceptOnTimeout: false } } });

    const out = await fullSuiteGateOp.execute(
      INPUT,
      ctxWithConfig({ execution: { regressionGate: { acceptOnTimeout: false } } }),
      controlledDeps(config, failingRun({ stopReason: STOP_REASON })),
    );

    expect(out.status).toBe("timeout");
    expect(out.success).toBe(false);
    expect(out.stopReason).toEqual(STOP_REASON);
  });

  // AC-14 — the real runner path produces exactly that shape: a list whose first
  // entry fails ordinarily while the second is stopped by the detector.
  test("the real runner path surfaces the list stop reason on a TEST_FAILURE aggregate", async () => {
    _executorDeps.spawn = makeSpawn(({ cmd }) =>
      cmd[2] === "stalls"
        ? stalledProc("stdout", GATE_POLICY.repeatedLineThreshold)
        : { stdout: "Tests: 1 failed, 0 passed", exitCode: 1 },
    ).spawn;
    const config = makeNaxConfig({
      quality: { stallDetection: GATE_POLICY, gracePeriodMs: 5, drainTimeoutMs: 20 },
      execution: { regressionGate: { acceptOnTimeout: false } },
    });

    const runResult = await _fullSuiteGateDeps.runTests(INPUT, gateContext(config, ["fails-first", "stalls"]));

    expect(runResult.passed).toBe(false);
    // The aggregate status is an ordinary code failure — no TIMEOUT to read.
    expect(runResult.timedOut).toBe(false);
    expect(runResult.stopReason).toEqual(STOP_REASON);
  });

  // AC-15
  test.each([true, false])("keeps the acceptOnTimeout outcome and carries the reason (accept=%s)", async (accept) => {
    const config = makeNaxConfig({ execution: { regressionGate: { acceptOnTimeout: accept } } });

    const out: FullSuiteGateOutput = await fullSuiteGateOp.execute(
      INPUT,
      ctxWithConfig({ execution: { regressionGate: { acceptOnTimeout: accept } } }),
      controlledDeps(config, failingRun({ stopReason: STOP_REASON })),
    );

    expect(out.status).toBe(accept ? "passed-on-timeout" : "timeout");
    expect(out.success).toBe(accept);
    expect(out.passed).toBe(accept);
    expect(out.stopReason).toEqual(STOP_REASON);
  });
});
