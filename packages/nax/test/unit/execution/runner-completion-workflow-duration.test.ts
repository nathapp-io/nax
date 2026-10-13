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
import type { RunCompleteFinal, RunCompletionResult } from "@/execution/lifecycle/run-completion";
import { _runnerCompletionDeps, type RunnerCompletionOptions, runCompletionPhase } from "@/execution/runner-completion";
import { _workflowEndReportDeps } from "@/execution/workflow-end-report";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";
import { pipelineEventBus } from "@/pipeline/event-bus";
import { _gitDeps } from "@/utils/git";

const EMPTY_SNAPSHOT = {
  totalCostUsd: 0,
  totalEstimatedCostUsd: 0,
  totalExactCostUsd: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  callCount: 0,
  errorCount: 0,
  totalErrorCostUsd: 0,
};
const WORKDIR = "/tmp/nax-test-runner-completion-wf-duration";
const STORIES_MS = 8_393_000;
const FEATURE_MS = 1_055_000;

function opts(mode: "workflow" | "pipeline", over: Partial<RunnerCompletionOptions> = {}): RunnerCompletionOptions {
  const runtime = makeMockRuntime();
  runtime.costAggregator.snapshot = mock(() => ({ ...EMPTY_SNAPSHOT, totalCostUsd: 4.25 }));
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
    ...over,
  };
}

let clock = 0;
let saved: Record<string, unknown>[] = [];
let runComplete: RunCompleteFinal[] = [];
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

let logs: LogEntry[] = [];
beforeEach(() => {
  resetLogger();
  logs = [];
  initLogger({ level: "silent" });
  addSink((entry) => logs.push(entry));
  clock = 1_000_000 + STORIES_MS;
  runComplete = [];
  _runnerCompletionDeps.now = () => clock;
  _runnerCompletionDeps.handleRunCompletion = mock(async (o) => ({
    ...base,
    durationMs: STORIES_MS,
    ...(o.deferRunCompleteLog ? { logRunComplete: (t: RunCompleteFinal) => void runComplete.push(t) } : {}),
  }));
  _runnerCompletionDeps.runWorkflowFeature = mock(async () => {
    clock += FEATURE_MS;
    return { passed: true, outcome: "ready" as const, reasons: [] };
  });
  _workflowEndReportDeps.readSummary = async () => null;
  saved = [];
  _workflowEndReportDeps.saveDuration = async (_dir, runId, patch) => {
    saved.push({ runId, ...patch });
    return true;
  };
  _gitDeps.spawn = makeSpawn().spawn;
});
afterEach(() => {
  resetLogger();
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
      {
        durationMs: STORIES_MS + FEATURE_MS,
        storiesDurationMs: STORIES_MS,
        featureWorkflowDurationMs: FEATURE_MS,
        totalCost: 4.25,
        workflowPassed: true,
      },
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

  test("the saved metrics record is rewritten with the whole-run duration and both parts (M1)", async () => {
    await runCompletionPhase(opts("workflow"));
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      runId: "run-001",
      totalDurationMs: STORIES_MS + FEATURE_MS,
      storiesDurationMs: STORIES_MS,
      featureWorkflowDurationMs: FEATURE_MS,
      totalCost: 4.25,
    });
    expect(typeof saved[0]?.completedAt).toBe("string");
  });

  test("pipeline mode does not touch the saved metrics record", async () => {
    await runCompletionPhase(opts("pipeline"));
    expect(saved).toHaveLength(0);
  });

  test("run.complete is written exactly once, as failed, when the feature workflow throws", async () => {
    _runnerCompletionDeps.runWorkflowFeature = mock(async () => {
      clock += FEATURE_MS;
      throw new Error("boom");
    });
    await runCompletionPhase(opts("workflow"));
    expect(runComplete).toHaveLength(1);
    expect(runComplete[0]).toMatchObject({ workflowPassed: false, featureWorkflowDurationMs: FEATURE_MS });
  });

  test("run.complete is written exactly once on the aborted path", async () => {
    await runCompletionPhase(opts("workflow", { exitReason: "aborted" }));
    expect(runComplete).toHaveLength(1);
    expect(runComplete[0]?.featureWorkflowDurationMs).toBe(0);
  });

  test("run.complete is still written once, with the timing so far, when the tail before the workflow rejects (L1)", async () => {
    const statusWriter = makeStatusWriter();
    statusWriter.writeFeatureStatus = mock(async () => {
      throw new Error("disk full");
    });
    await expect(runCompletionPhase(opts("workflow", { statusWriter, featureDir: `${WORKDIR}/feat` }))).rejects.toThrow(
      "disk full",
    );
    expect(runComplete).toHaveLength(1);
    expect(runComplete[0]).toMatchObject({ workflowPassed: false, featureWorkflowDurationMs: 0, totalCost: 0 });
  });

  test("a missing metrics record is a warning, not silence (item 5)", async () => {
    _workflowEndReportDeps.saveDuration = async () => false;
    await runCompletionPhase(opts("workflow"));
    expect(logs.some((e) => e.level === "warn" && e.message.startsWith("No saved run metrics"))).toBe(true);
  });

  test("a fault in the fallback run.complete write cannot mask the original rejection (item 2)", async () => {
    const statusWriter = makeStatusWriter();
    statusWriter.writeFeatureStatus = mock(async () => {
      throw new Error("disk full");
    });
    _runnerCompletionDeps.now = () => {
      throw new Error("clock fault");
    };
    await expect(runCompletionPhase(opts("workflow", { statusWriter, featureDir: `${WORKDIR}/feat` }))).rejects.toThrow(
      "disk full",
    );
    expect(logs.some((e) => e.level === "warn" && e.message.includes("fallback run.complete"))).toBe(true);
  });
});
