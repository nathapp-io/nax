/**
 * US-003 (SEAM-2) — `runExecutionPhase` runs `execution.preRun` once, after the
 * package-dir bootstrap and before the run-start baseline capture and the first
 * story dispatch, and a failing step stops the run: no baseline, no iteration,
 * run status `failed`.
 *
 * The steps run through `_preRunDeps`, the baseline through `_captureDeps` and
 * the story loop through `_unifiedExecutorDeps`, so a recorded call order
 * observes the wiring without spawning a process or dispatching a story.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  assertNaxError,
  makeDispatchContext,
  makeNaxConfig,
  makePluginRegistry,
  makePRD,
  makeStatusWriter,
  makeStory,
} from "@test/helpers";
import type { NaxConfig } from "@/config";
import { NaxError } from "@/errors";
import { _preRunDeps } from "@/execution/lifecycle/pre-run-steps";
import { _captureDeps } from "@/execution/lifecycle/test-baseline-capture";
import type { RunnerExecutionOptions } from "@/execution/runner-execution";
import { runExecutionPhase } from "@/execution/runner-execution";
import { _unifiedExecutorDeps } from "@/execution/unified-executor";
import type { UserStory } from "@/prd";
import type { TestExecutionResult } from "@/verification";

const WORKDIR = "/tmp/nax-runner-exec-pre-run";
const FEATURE = "feat-pre-run";

const originalPreRunDeps = { ..._preRunDeps };
const origWriteRunBaseline = _captureDeps.writeRunBaseline;
const origClearStoryBaselines = _captureDeps.clearStoryBaselines;
const origGateEnabled = _captureDeps.regressionGateEnabled;
const origRunIteration = _unifiedExecutorDeps.runIteration;
const origRunParallelBatch = _unifiedExecutorDeps.runParallelBatch;
const origSelectIndependentBatch = _unifiedExecutorDeps.selectIndependentBatch;
const origRunWorkflowPreflight = _unifiedExecutorDeps.runWorkflowPreflight;

/** Recorded call order across the pre-run seam, the baseline and the story loop. */
let callOrder: string[] = [];
let stepResults: TestExecutionResult[] = [];

function ok(overrides: Partial<TestExecutionResult> = {}): TestExecutionResult {
  return { success: true, timeout: false, exitCode: 0, output: "", countsTowardEscalation: true, ...overrides };
}

/**
 * `acceptance.enabled: false` keeps `executeUnified` off the pre/post-run
 * acceptance pipelines — this file asserts the pre-run/baseline/dispatch order
 * with a stubbed story loop, not pipeline behaviour.
 */
function makeOptions(
  preRun: NaxConfig["execution"]["preRun"],
  overrides: Partial<RunnerExecutionOptions> = {},
): RunnerExecutionOptions {
  return {
    ...makeDispatchContext(),
    prdPath: `${WORKDIR}/prd.json`,
    workdir: WORKDIR,
    config: makeNaxConfig({ acceptance: { enabled: false }, execution: { preRun, iterationDelayMs: 0 } }),
    hooks: { hooks: {}, _skipGlobal: false },
    feature: FEATURE,
    featureDir: undefined,
    dryRun: false,
    useBatch: false,
    statusWriter: makeStatusWriter(),
    statusFile: `${WORKDIR}/status.json`,
    logFilePath: undefined,
    runId: "run-pre-run",
    startedAt: new Date(0).toISOString(),
    startTime: 0,
    formatterMode: "quiet",
    headless: false,
    ...overrides,
  };
}

function pendingPRD() {
  return makePRD({ feature: FEATURE, userStories: [makeStory({ id: "US-001", status: "pending" })] });
}

beforeEach(() => {
  callOrder = [];
  stepResults = [];

  _preRunDeps.assertTrusted = async () => {};
  _preRunDeps.executeWithTimeout = async (command) => {
    callOrder.push(`preRun:${command}`);
    return stepResults.shift() ?? ok();
  };

  _captureDeps.clearStoryBaselines = async () => {};
  // Gate disabled: the capture step takes its no-command branch, so the test
  // observes the call site without resolving or spawning a real test command.
  _captureDeps.regressionGateEnabled = () => false;
  _captureDeps.writeRunBaseline = async () => {
    callOrder.push("writeRunBaseline");
  };

  _unifiedExecutorDeps.runWorkflowPreflight = async () => {};
  _unifiedExecutorDeps.selectIndependentBatch = () => [];
  _unifiedExecutorDeps.runParallelBatch = (async () => ({
    batchResults: [],
    totalCost: 0,
    completed: [] satisfies UserStory[],
    exitReason: "all-stories-passed" as const,
    failed: [],
    mergeConflicts: [],
    storyCosts: new Map(),
  })) as typeof _unifiedExecutorDeps.runParallelBatch;
  _unifiedExecutorDeps.runIteration = (async () => {
    callOrder.push("runIteration");
    return {
      prd: makePRD({ feature: FEATURE, userStories: [makeStory({ id: "US-001", status: "passed" })] }),
      storiesCompletedDelta: 1,
      costDelta: 0,
      prdDirty: false,
      finalAction: "continue",
    };
  }) as typeof _unifiedExecutorDeps.runIteration;
});

afterEach(() => {
  Object.assign(_preRunDeps, originalPreRunDeps);
  _captureDeps.writeRunBaseline = origWriteRunBaseline;
  _captureDeps.clearStoryBaselines = origClearStoryBaselines;
  _captureDeps.regressionGateEnabled = origGateEnabled;
  _unifiedExecutorDeps.runIteration = origRunIteration;
  _unifiedExecutorDeps.runParallelBatch = origRunParallelBatch;
  _unifiedExecutorDeps.selectIndependentBatch = origSelectIndependentBatch;
  _unifiedExecutorDeps.runWorkflowPreflight = origRunWorkflowPreflight;
});

describe("runExecutionPhase — execution.preRun", () => {
  test("AC-15: runs a pre-run step before the run-start baseline capture", async () => {
    const options = makeOptions([{ command: "up", timeoutSeconds: 30 }]);

    await runExecutionPhase(options, pendingPRD(), makePluginRegistry());

    expect(callOrder).toEqual(["preRun:up", "writeRunBaseline", "runIteration"]);
  });

  test("AC-26: with no steps configured, the baseline still precedes the first story dispatch", async () => {
    await runExecutionPhase(makeOptions([]), pendingPRD(), makePluginRegistry());

    expect(callOrder).toEqual(["writeRunBaseline", "runIteration"]);
  });

  test("AC-16 + AC-17 + AC-18: a failing step rejects PRE_RUN_FAILED and nothing downstream runs", async () => {
    stepResults = [ok({ success: false, exitCode: 2, output: "port in use" })];
    const options = makeOptions([{ command: "up", timeoutSeconds: 30 }]);

    const caught = await runExecutionPhase(options, pendingPRD(), makePluginRegistry()).then(
      () => undefined,
      (err: unknown) => err,
    );

    assertNaxError(caught, "runExecutionPhase rejection");
    expect(caught.code).toBe("PRE_RUN_FAILED");
    expect(callOrder).toEqual(["preRun:up"]);
    expect(callOrder).not.toContain("writeRunBaseline");
    expect(callOrder).not.toContain("runIteration");
  });

  test("AC-19 + AC-24: the failing case marks the run failed and persists update(0, 0) before propagating", async () => {
    stepResults = [ok({ success: false, exitCode: 2 })];
    const statusCalls: string[] = [];
    const setRunStatus = mock((status: string) => {
      statusCalls.push(`setRunStatus:${status}`);
    });
    const update = mock(async (cost: number, iterations: number) => {
      statusCalls.push(`update:${cost},${iterations}`);
    });
    const statusWriter = makeStatusWriter({ setRunStatus, update });
    const options = makeOptions([{ command: "up", timeoutSeconds: 30 }], { statusWriter });

    await runExecutionPhase(options, pendingPRD(), makePluginRegistry()).then(
      () => undefined,
      () => undefined,
    );

    expect(setRunStatus).toHaveBeenCalledWith("failed");
    expect(statusCalls.slice(-2)).toEqual(["setRunStatus:failed", "update:0,0"]);
  });

  test("AC-23: a PROJECT_UNTRUSTED refusal from the step also marks the run failed", async () => {
    _preRunDeps.assertTrusted = async () => {
      throw new NaxError("[trust] refusing to run pre-run", "PROJECT_UNTRUSTED", { stage: "trust" });
    };
    const statusWriter = makeStatusWriter();
    const options = makeOptions([{ command: "up", timeoutSeconds: 30 }], { statusWriter });

    const caught = await runExecutionPhase(options, pendingPRD(), makePluginRegistry()).then(
      () => undefined,
      (err: unknown) => err,
    );

    assertNaxError(caught, "runExecutionPhase rejection");
    expect(caught.code).toBe("PROJECT_UNTRUSTED");
    expect(statusWriter.setRunStatus).toHaveBeenCalledWith("failed");
    expect(callOrder).toEqual([]);
  });

  test("AC-20: a dry run never runs the configured step", async () => {
    const options = makeOptions([{ command: "up", timeoutSeconds: 30 }], { dryRun: true });

    await runExecutionPhase(options, makePRD({ feature: FEATURE }), makePluginRegistry());

    expect(callOrder).not.toContain("preRun:up");
  });
});
