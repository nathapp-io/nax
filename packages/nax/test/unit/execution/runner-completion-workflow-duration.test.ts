/**
 * nax#2491: in workflow mode the run's Duration runs through the end of the feature workflow,
 * and run.complete is written after it with the stories / feature-workflow split.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  makeMockRuntime,
  makeNaxConfig,
  makePluginRegistry,
  makePRD,
  makeSpawn,
  makeStatusWriter,
  makeStory,
} from "@test/helpers";
import type { RunCompleteTiming, RunCompletionResult } from "@/execution/lifecycle/run-completion";
import { _runnerCompletionDeps, type RunnerCompletionOptions, runCompletionPhase } from "@/execution/runner-completion";
import { _workflowEndReportDeps } from "@/execution/workflow-end-report";
import { pipelineEventBus } from "@/pipeline/event-bus";
import { _gitDeps } from "@/utils/git";

const WORKDIR = "/tmp/nax-test-runner-completion-wf-duration";
const STORIES_MS = 8_393_000;
const FEATURE_MS = 1_055_000;

function opts(mode: "workflow" | "pipeline"): RunnerCompletionOptions {
  const runtime = makeMockRuntime();
  return {
    config: makeNaxConfig({
      acceptance: { enabled: false },
      execution: { mode, regressionGate: { mode: "disabled" } },
    }),
    hooks: { hooks: {}, _skipGlobal: false },
    feature: "f",
    workdir: WORKDIR,
    statusFile: `${WORKDIR}/status.json`,
    runId: "run-001",
    startedAt: new Date().toISOString(),
    startTime: 1_000_000,
    formatterMode: "quiet",
    headless: false,
    prd: makePRD({ userStories: [makeStory({ id: "US-001", status: "passed", passes: true })] }),
    allStoryMetrics: [],
    totalCost: 0,
    storiesCompleted: 1,
    iterations: 1,
    statusWriter: makeStatusWriter(),
    pluginRegistry: makePluginRegistry(),
    prdPath: `${WORKDIR}/prd.json`,
    runtime,
    agentManager: runtime.agentManager,
    sessionManager: runtime.sessionManager,
    abortSignal: runtime.signal,
  };
}

let clock = 0;
let runComplete: RunCompleteTiming[] = [];
const base: RunCompletionResult = {
  durationMs: 100,
  runCompletedAt: new Date().toISOString(),
  reportedTotal: 0,
  finalCounts: { total: 1, passed: 1, failed: 0, skipped: 0, pending: 0 },
  pluginGateFailed: false,
};
const origDeps = { ..._runnerCompletionDeps };
const origReport = { ..._workflowEndReportDeps };
const origGit = _gitDeps.spawn;

beforeEach(() => {
  clock = 1_000_000 + STORIES_MS;
  runComplete = [];
  _runnerCompletionDeps.now = () => clock;
  _runnerCompletionDeps.handleRunCompletion = mock(async (o) => ({
    ...base,
    durationMs: STORIES_MS,
    ...(o.deferRunCompleteLog ? { logRunComplete: (t: RunCompleteTiming) => void runComplete.push(t) } : {}),
  }));
  _runnerCompletionDeps.runWorkflowFeature = mock(async () => {
    clock += FEATURE_MS;
    return { passed: true, outcome: "ready" as const, reasons: [] };
  });
  _workflowEndReportDeps.readSummary = async () => null;
  _gitDeps.spawn = makeSpawn().spawn;
});
afterEach(() => {
  Object.assign(_runnerCompletionDeps, origDeps);
  Object.assign(_workflowEndReportDeps, origReport);
  _gitDeps.spawn = origGit;
  pipelineEventBus.clear();
  mock.restore();
});

describe("runCompletionPhase — Duration in workflow mode (nax#2491)", () => {
  test("durationMs spans the feature workflow and the run.complete line gets the split", async () => {
    const result = await runCompletionPhase(opts("workflow"));
    expect(result.durationMs).toBe(STORIES_MS + FEATURE_MS);
    expect(runComplete).toEqual([
      { durationMs: STORIES_MS + FEATURE_MS, storiesDurationMs: STORIES_MS, featureWorkflowDurationMs: FEATURE_MS },
    ]);
  });

  test("handleRunCompletion is asked to hold run.complete back", async () => {
    await runCompletionPhase(opts("workflow"));
    const call = (_runnerCompletionDeps.handleRunCompletion as ReturnType<typeof mock>).mock.calls[0];
    expect(call?.[0]).toMatchObject({ deferRunCompleteLog: true });
  });

  test("pipeline mode is untouched: no deferral, durationMs as completed", async () => {
    const result = await runCompletionPhase(opts("pipeline"));
    expect(result.durationMs).toBe(STORIES_MS);
    const call = (_runnerCompletionDeps.handleRunCompletion as ReturnType<typeof mock>).mock.calls[0];
    expect(call?.[0]).not.toMatchObject({ deferRunCompleteLog: true });
    expect(runComplete).toHaveLength(0);
  });
});
