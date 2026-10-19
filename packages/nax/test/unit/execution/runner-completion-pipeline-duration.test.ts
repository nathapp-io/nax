/**
 * nax#2494: in pipeline mode the run's Duration runs through the end phase (finish, ...), and
 * run.complete is written after it with the stories / end-phase split.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
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
const WORKDIR = "/tmp/nax-test-runner-completion-pipeline-duration";
const STORIES_MS = 8_393_000;
const FINISH_MS = 612_000;

function opts(over: Partial<RunnerCompletionOptions> = {}): RunnerCompletionOptions {
  const runtime = makeMockRuntime();
  runtime.costAggregator.snapshot = mock(() => ({ ...EMPTY_SNAPSHOT, totalCostUsd: 4.25 }));
  return {
    config: makeNaxConfig({
      acceptance: { enabled: false },
      execution: { mode: "pipeline", regressionGate: { mode: "disabled" } },
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
  _runnerCompletionDeps.runFinishPhase = mock(async () => {
    clock += FINISH_MS;
    return null;
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

describe("runCompletionPhase — Duration in pipeline mode (nax#2494)", () => {
  test("durationMs spans the end phase and the run.complete line gets the split", async () => {
    const result = await runCompletionPhase(opts());
    expect(result.durationMs).toBe(STORIES_MS + FINISH_MS);
    expect(runComplete).toEqual([
      {
        durationMs: STORIES_MS + FINISH_MS,
        storiesDurationMs: STORIES_MS,
        endPhaseDurationMs: FINISH_MS,
        totalCost: 4.25,
        workflowPassed: true,
        reasons: [],
      },
    ]);
  });

  test("handleRunCompletion is asked to hold run.complete back", async () => {
    await runCompletionPhase(opts());
    expect(_runnerCompletionDeps.handleRunCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ deferRunCompleteLog: true }),
    );
  });

  test("the saved metrics record is rewritten with the whole-run duration and the end-phase split", async () => {
    await runCompletionPhase(opts());
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      runId: "run-001",
      totalDurationMs: STORIES_MS + FINISH_MS,
      storiesDurationMs: STORIES_MS,
      endPhaseDurationMs: FINISH_MS,
      totalCost: 4.25,
    });
    expect(saved[0]).not.toHaveProperty("featureWorkflowDurationMs");
    expect(typeof saved[0]?.completedAt).toBe("string");
  });

  test("a finish that throws is fail-open: the run still closes once, with the time it took", async () => {
    _runnerCompletionDeps.runFinishPhase = mock(async () => {
      clock += FINISH_MS;
      throw new Error("boom");
    });
    await runCompletionPhase(opts());
    expect(runComplete).toHaveLength(1);
    expect(runComplete[0]).toMatchObject({ workflowPassed: true, endPhaseDurationMs: FINISH_MS });
  });

  test("run.complete is still written once, with the timing so far, when the tail before finish rejects", async () => {
    const statusWriter = makeStatusWriter();
    statusWriter.writeFeatureStatus = mock(async () => {
      throw new Error("disk full");
    });
    await expect(runCompletionPhase(opts({ statusWriter, featureDir: `${WORKDIR}/feat` }))).rejects.toThrow(
      "disk full",
    );
    expect(runComplete).toHaveLength(1);
    expect(runComplete[0]).toMatchObject({ endPhaseDurationMs: 0, storiesDurationMs: STORIES_MS });
    expect(runComplete[0]).not.toHaveProperty("featureWorkflowDurationMs");
  });

  test("a missing metrics record is a warning, not silence", async () => {
    _workflowEndReportDeps.saveDuration = async () => false;
    await runCompletionPhase(opts());
    expect(logs.some((e) => e.level === "warn" && e.message.startsWith("No saved run metrics"))).toBe(true);
  });

  test("the footer shows the split only when the end phase took a second or more", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await runCompletionPhase(opts({ headless: true, formatterMode: "normal" }));
      expect(log.mock.calls.map((c) => String(c[0])).join("\n")).toContain("end phase");
      log.mockClear();
      _runnerCompletionDeps.runFinishPhase = mock(async () => {
        clock += 400;
        return null;
      });
      clock = 1_000_000 + STORIES_MS;
      await runCompletionPhase(opts({ headless: true, formatterMode: "normal" }));
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toContain("Duration");
      expect(out).not.toContain("end phase");
    } finally {
      log.mockRestore();
    }
  });

  test("no workflow summary line is logged in pipeline mode", async () => {
    await runCompletionPhase(opts());
    expect(logs.some((e) => e.message.startsWith("Workflow summary"))).toBe(false);
  });
});
