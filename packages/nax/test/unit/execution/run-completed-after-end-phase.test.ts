/**
 * run:completed is deferred past the end phase (finish / feature workflow) and emitted through the
 * same exactly-once gate as run.complete, with the whole-run figures and the end-phase verdict.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import {
  cleanupTempDir,
  makeMockRuntime,
  makeNaxConfig,
  makePluginRegistry,
  makePRD,
  makeSpawn,
  makeStatusWriter,
  makeStory,
  makeTempDir,
} from "@test/helpers";
import { NaxError } from "@/errors";
import type { RunCompleteFinal, RunCompletionOptions, RunCompletionResult } from "@/execution/lifecycle/run-completion";
import { _runnerCompletionDeps, type RunnerCompletionOptions, runCompletionPhase } from "@/execution/runner-completion";
import { _workflowEndReportDeps } from "@/execution/workflow-end-report";
import { initLogger, resetLogger } from "@/logger";
import { pipelineEventBus } from "@/pipeline/event-bus";
import { wireHooks } from "@/pipeline/subscribers/hooks";
import { _gitDeps } from "@/utils/git";

const EMPTY_SNAPSHOT = {
  totalCostUsd: 4.25,
  totalEstimatedCostUsd: 0,
  totalExactCostUsd: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  callCount: 0,
  errorCount: 0,
  totalErrorCostUsd: 0,
};
const WORKDIR = "/tmp/nax-test-run-completed-after-end-phase";
const START = 1_000_000;
const STORIES_MS = 8_000;
const FEATURE_MS = 1_000;
const PR_URL = "https://github.com/o/r/pull/295";

type Mode = "workflow" | "pipeline";

function opts(mode: Mode, over: Partial<RunnerCompletionOptions> = {}): RunnerCompletionOptions {
  const runtime = makeMockRuntime();
  runtime.costAggregator.snapshot = mock(() => EMPTY_SNAPSHOT);
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
    startTime: START,
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
let emitted: RunCompleteFinal[] = [];
let order: string[] = [];
let handleOpts: RunCompletionOptions[] = [];
let emitRunCompleted: ReturnType<typeof mock<(final: RunCompleteFinal) => void>>;
const base: RunCompletionResult = {
  durationMs: STORIES_MS,
  runCompletedAt: new Date().toISOString(),
  reportedTotal: 3.5,
  finalCounts: { total: 1, passed: 1, failed: 0, skipped: 0, pending: 0 },
  pluginGateFailed: false,
};
const origDeps = { ..._runnerCompletionDeps };
const origReport = { ..._workflowEndReportDeps };
const origGit = _gitDeps.spawn;

function stubWorkflow(result: Awaited<ReturnType<typeof _runnerCompletionDeps.runWorkflowFeature>>): void {
  _runnerCompletionDeps.runWorkflowFeature = mock(async () => {
    order.push("end-phase");
    clock += FEATURE_MS;
    return result;
  });
}

beforeEach(() => {
  resetLogger();
  initLogger({ level: "silent" });
  clock = START + STORIES_MS;
  emitted = [];
  order = [];
  handleOpts = [];
  emitRunCompleted = mock((final: RunCompleteFinal) => {
    order.push("emit");
    emitted.push(final);
  });
  _runnerCompletionDeps.now = () => clock;
  _runnerCompletionDeps.handleRunCompletion = mock(async (o: RunCompletionOptions) => {
    handleOpts.push(o);
    return { ...base, emitRunCompleted };
  });
  stubWorkflow({ passed: true, outcome: "ready", reasons: [] });
  _runnerCompletionDeps.runFinishPhase = mock(async () => {
    order.push("end-phase");
    clock += FEATURE_MS;
    return null;
  });
  _workflowEndReportDeps.readSummary = async () => null;
  _workflowEndReportDeps.saveDuration = async () => true;
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

describe("runCompletionPhase — deferred run:completed in workflow mode", () => {
  test("handleRunCompletion is asked to defer the event", async () => {
    await runCompletionPhase(opts("workflow"));
    expect(handleOpts[0]).toMatchObject({ deferRunCompletedEvent: true });
  });

  test("a passing workflow emits once, after the workflow, with the verdict and the PR url", async () => {
    stubWorkflow({ passed: true, outcome: "ready", url: PR_URL, reasons: [] });
    await runCompletionPhase(opts("workflow"));
    expect(emitRunCompleted).toHaveBeenCalledTimes(1);
    expect(emitted[0]).toMatchObject({
      workflowPassed: true,
      url: PR_URL,
      durationMs: STORIES_MS + FEATURE_MS,
      totalCost: 4.25,
    });
    expect(order).toEqual(["end-phase", "emit"]);
  });

  test("a draft workflow emits once as not passed, carrying its reasons", async () => {
    stubWorkflow({ passed: false, outcome: "draft", reasons: ["final gates red: lint"] });
    await runCompletionPhase(opts("workflow"));
    expect(emitRunCompleted).toHaveBeenCalledTimes(1);
    expect(emitted[0]).toMatchObject({ workflowPassed: false, reasons: ["final gates red: lint"] });
  });

  test("a throwing workflow emits once as not passed with the failure message", async () => {
    _runnerCompletionDeps.runWorkflowFeature = mock(async () => {
      throw new Error("boom");
    });
    await runCompletionPhase(opts("workflow"));
    expect(emitRunCompleted).toHaveBeenCalledTimes(1);
    expect(emitted[0]).toMatchObject({ workflowPassed: false, reasons: ["feature workflow failed: boom"] });
  });

  test("an already-finished workflow carries its prior url and verdict", async () => {
    stubWorkflow({ passed: true, outcome: "already-finished", url: PR_URL, reasons: [] });
    await runCompletionPhase(opts("workflow"));
    expect(emitRunCompleted).toHaveBeenCalledTimes(1);
    expect(emitted[0]).toMatchObject({ url: PR_URL, workflowPassed: true });
  });

  test("a skipped workflow on an aborted run emits once as not passed with 'run aborted'", async () => {
    await runCompletionPhase(opts("workflow", { exitReason: "aborted" }));
    expect(emitRunCompleted).toHaveBeenCalledTimes(1);
    expect(emitted[0]).toMatchObject({ workflowPassed: false, reasons: ["run aborted"] });
  });

  test("a workflow that rejects with WORKFLOW_ABORTED emits once as not passed with 'run aborted'", async () => {
    _runnerCompletionDeps.runWorkflowFeature = mock(async () => {
      throw new NaxError("aborted", "WORKFLOW_ABORTED", { stage: "workflow" });
    });
    await runCompletionPhase(opts("workflow"));
    expect(emitRunCompleted).toHaveBeenCalledTimes(1);
    expect(emitted[0]).toMatchObject({ workflowPassed: false, reasons: ["run aborted"] });
  });
});

describe("runCompletionPhase — deferred run:completed in pipeline mode", () => {
  test("emits once after finish, as passed, with no url and an empty reasons list", async () => {
    await runCompletionPhase(opts("pipeline"));
    expect(emitRunCompleted).toHaveBeenCalledTimes(1);
    expect(emitted[0]).toMatchObject({ workflowPassed: true, reasons: [], endPhaseDurationMs: FEATURE_MS });
    expect(Object.keys(emitted[0] ?? {})).not.toContain("url");
    expect(order).toEqual(["end-phase", "emit"]);
  });
});

describe("runCompletionPhase — rejection paths", () => {
  function rejectingFeatureStatus(): Partial<RunnerCompletionOptions> {
    const statusWriter = makeStatusWriter();
    statusWriter.writeFeatureStatus = mock(async () => {
      throw new Error("disk full");
    });
    return { statusWriter, featureDir: `${WORKDIR}/feat` };
  }

  test("a rejection before the end phase closes emits once, as not passed, from the fallback, then propagates", async () => {
    await expect(runCompletionPhase(opts("workflow", rejectingFeatureStatus()))).rejects.toThrow("disk full");
    expect(emitRunCompleted).toHaveBeenCalledTimes(1);
    expect(emitted[0]).toEqual({
      durationMs: clock - START,
      storiesDurationMs: clock - START,
      featureWorkflowDurationMs: 0,
      totalCost: base.reportedTotal,
      workflowPassed: false,
    });
  });

  test("the rejection propagates only after an async run:completed subscriber has settled", async () => {
    let settled = false;
    pipelineEventBus.on("run:completed", () => {
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          settled = true;
          resolve();
        }, 50);
      });
    });
    emitRunCompleted = mock(() => {
      pipelineEventBus.emit({
        type: "run:completed",
        totalStories: 1,
        passedStories: 1,
        failedStories: 0,
        skippedStories: 0,
        pausedStories: 0,
        durationMs: 1,
      });
    });
    _runnerCompletionDeps.handleRunCompletion = mock(async () => ({ ...base, emitRunCompleted }));
    await expect(runCompletionPhase(opts("workflow", rejectingFeatureStatus()))).rejects.toThrow("disk full");
    expect(settled).toBe(true);
  });

  test("a successful run resolves only after an async run:completed subscriber has settled", async () => {
    let settled = false;
    pipelineEventBus.on("run:completed", () => {
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          settled = true;
          resolve();
        }, 50);
      });
    });
    emitRunCompleted = mock(() => {
      pipelineEventBus.emit({
        type: "run:completed",
        totalStories: 1,
        passedStories: 1,
        failedStories: 0,
        skippedStories: 0,
        pausedStories: 0,
        durationMs: 1,
      });
    });
    _runnerCompletionDeps.handleRunCompletion = mock(async () => ({ ...base, emitRunCompleted }));
    await runCompletionPhase(opts("workflow"));
    expect(settled).toBe(true);
  });

  test("the fallback emission reaches on-complete with neither NAX_REASON nor NAX_RESULT_URL", async () => {
    const dir = makeTempDir("nax-run-completed-hook-");
    try {
      const envFile = join(dir, "env.txt");
      const script = join(dir, "record.sh");
      await Bun.write(script, `#!/bin/sh\nenv | grep '^NAX_' > "$1"\n`);
      wireHooks(
        pipelineEventBus,
        { hooks: { "on-complete": { command: `sh ${script} ${envFile}`, enabled: true } } },
        dir,
        "f",
      );
      emitRunCompleted = mock((final: RunCompleteFinal) => {
        pipelineEventBus.emit({
          type: "run:completed",
          totalStories: 1,
          passedStories: 1,
          failedStories: 0,
          skippedStories: 0,
          pausedStories: 0,
          durationMs: final.durationMs,
          totalCost: final.totalCost,
          workflowPassed: final.workflowPassed,
          ...(final.url !== undefined ? { url: final.url } : {}),
          ...(final.reasons !== undefined ? { reasons: final.reasons } : {}),
        });
      });
      _runnerCompletionDeps.handleRunCompletion = mock(async () => ({ ...base, emitRunCompleted }));
      await expect(runCompletionPhase(opts("workflow", rejectingFeatureStatus()))).rejects.toThrow("disk full");
      const env = await Bun.file(envFile).text();
      expect(env).toContain("NAX_STATUS=failed");
      expect(env).not.toContain("NAX_REASON");
      expect(env).not.toContain("NAX_RESULT_URL");
    } finally {
      cleanupTempDir(dir);
    }
  });

  test("a rejection after finishRun propagates without a second event or a changed verdict", async () => {
    stubWorkflow({ passed: false, outcome: "draft", reasons: ["final gates red: lint"] });
    const statusWriter = makeStatusWriter();
    statusWriter.update = mock(async () => {
      throw new Error("status write failed");
    });
    await expect(runCompletionPhase(opts("workflow", { statusWriter }))).rejects.toThrow("status write failed");
    expect(emitRunCompleted).toHaveBeenCalledTimes(1);
    expect(emitted[0]).toMatchObject({ workflowPassed: false, reasons: ["final gates red: lint"] });
  });

  test("a runtime.close rejection after finishRun propagates without a second event", async () => {
    const o = opts("workflow");
    o.runtime.close = mock(async () => {
      throw new Error("close failed");
    });
    await expect(runCompletionPhase(o)).rejects.toThrow("close failed");
    expect(emitRunCompleted).toHaveBeenCalledTimes(1);
    expect(emitted[0]).toMatchObject({ workflowPassed: true });
  });

  test("a recordAdvisorSummary rejection after finishRun propagates without a second event", async () => {
    const o = opts("workflow");
    let after = false;
    emitRunCompleted = mock((final: RunCompleteFinal) => {
      emitted.push(final);
      after = true;
    });
    _runnerCompletionDeps.handleRunCompletion = mock(async () => ({ ...base, emitRunCompleted }));
    Object.defineProperty(o.config, "advisor", {
      get() {
        if (after) throw new Error("advisor config failed");
        return undefined;
      },
    });
    await expect(runCompletionPhase(o)).rejects.toThrow("advisor config failed");
    expect(emitRunCompleted).toHaveBeenCalledTimes(1);
    expect(emitted[0]).toMatchObject({ workflowPassed: true });
  });
});
