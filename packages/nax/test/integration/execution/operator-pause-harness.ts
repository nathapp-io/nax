/**
 * Harness for the operator-PAUSE integration tests: drives the real dispatch loop
 * (`executeUnified` -> `runIteration` -> the real queue-check stage -> result handlers) and the real
 * completion phase, with only the implementer and the feature workflow faked.
 */
import { mock } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  makeDispatchContext,
  makeMockRuntime,
  makeNaxConfig,
  makePluginRegistry,
  makePRD,
  makeSequentialExecutionContext,
  makeStory,
} from "@test/helpers";
import type { NaxConfig } from "@/config";
import { _heartbeatDeps } from "@/execution/crash-heartbeat";
import { stopHeartbeat } from "@/execution/crash-recovery";
import { _iterationRunnerDeps } from "@/execution/iteration-runner";
import { _runnerCompletionDeps, runCompletionPhase } from "@/execution/runner-completion";
import { StatusWriter } from "@/execution/status-writer";
import { _unifiedExecutorDeps, executeUnified } from "@/execution/unified-executor";
import { _workflowEndReportDeps } from "@/execution/workflow-end-report";
import { runPipeline } from "@/pipeline/runner";
import { queueCheckStage } from "@/pipeline/stages";
import type { PipelineContext, PipelineStage, StageResult } from "@/pipeline/types";
import { _prdCommitDeps, loadPRD, markStoryPassed, savePRD } from "@/prd";
import type { PRD, UserStory } from "@/prd/types";

export interface PauseHarness {
  root: string;
  prdPath: string;
  featureDir: string;
  config: NaxConfig;
  /** Story ids the fake implementer was called for, in order. */
  calls: string[];
  /** Called inside the implementer, while the story is in flight; may return a stage result. */
  onImplement: (story: UserStory) => Promise<StageResult | undefined> | StageResult | undefined;
  runWorkflowFeature: ReturnType<typeof mock>;
  /** One invocation: the dispatch loop, then completion + finish-status reconciliation. */
  invoke: () => Promise<{ exitReason: string }>;
  /** The persisted PRD. */
  prd: () => Promise<PRD>;
  /** The two physical status files' run.status. */
  runStatuses: () => Promise<{ project: string; feature: string }>;
  queue: (text: string) => Promise<void>;
}

const saved = {
  iteration: { ..._iterationRunnerDeps },
  executor: { ..._unifiedExecutorDeps },
  completion: { ..._runnerCompletionDeps },
  report: { ..._workflowEndReportDeps },
  commit: { ..._prdCommitDeps },
  heartbeat: { ..._heartbeatDeps },
};

export function restorePauseHarnessDeps(): void {
  stopHeartbeat();
  Object.assign(_iterationRunnerDeps, saved.iteration);
  Object.assign(_unifiedExecutorDeps, saved.executor);
  Object.assign(_runnerCompletionDeps, saved.completion);
  Object.assign(_workflowEndReportDeps, saved.report);
  Object.assign(_prdCommitDeps, saved.commit);
  Object.assign(_heartbeatDeps, saved.heartbeat);
}

export async function makePauseHarness(root: string, stories: UserStory[]): Promise<PauseHarness> {
  const feature = "pause-feature";
  const featureDir = join(root, ".nax", "features", feature);
  mkdirSync(featureDir, { recursive: true });
  const prdPath = join(featureDir, "prd.json");
  await savePRD(makePRD({ feature, userStories: stories }), prdPath);

  const config = makeNaxConfig({ execution: { iterationDelayMs: 0, mode: "workflow" } });
  const statusFile = join(root, "status.json");
  const statusWriter = new StatusWriter(statusFile, config, {
    runId: "run-pause",
    feature,
    startedAt: new Date().toISOString(),
    dryRun: false,
    startTimeMs: Date.now(),
    pid: process.pid,
  });

  const h: PauseHarness = {
    root,
    prdPath,
    featureDir,
    config,
    calls: [],
    onImplement: () => undefined,
    runWorkflowFeature: mock(async () => ({ passed: true, outcome: "ready" as const, reasons: [] })),
    invoke: async () => {
      // The completion phase closes (and aborts) its runtime, so a resume needs a fresh one.
      const runtime = makeMockRuntime({ config, workdir: root });
      const prd = await loadPRD(prdPath);
      const ctx = makeSequentialExecutionContext({
        ...makeDispatchContext({ runtime }),
        config,
        workdir: root,
        prdPath,
        featureDir,
        feature,
        statusWriter,
        pluginRegistry: makePluginRegistry(),
        runId: "run-pause",
        startTime: Date.now(),
      });
      statusWriter.setPrd(prd);
      statusWriter.setRunStatus("running");
      const result = await executeUnified(ctx, prd);
      await runCompletionPhase({
        config,
        hooks: { hooks: {}, _skipGlobal: false },
        feature,
        workdir: root,
        statusFile,
        featureDir,
        logFilePath: undefined,
        runId: "run-pause",
        startedAt: new Date().toISOString(),
        startTime: Date.now() - 1000,
        formatterMode: "quiet",
        headless: false,
        prd: result.prd,
        allStoryMetrics: [],
        totalCost: 0,
        storiesCompleted: result.storiesCompleted,
        iterations: result.iterations,
        statusWriter,
        pluginRegistry: makePluginRegistry(),
        prdPath,
        runtime,
        agentManager: runtime.agentManager,
        sessionManager: runtime.sessionManager,
        abortSignal: runtime.signal,
        exitReason: result.exitReason,
      });
      return { exitReason: result.exitReason };
    },
    prd: () => loadPRD(prdPath),
    runStatuses: async () => ({
      project: ((await Bun.file(statusFile).json()) as { run: { status: string } }).run.status,
      feature: ((await Bun.file(join(featureDir, "status.json")).json()) as { run: { status: string } }).run.status,
    }),
    queue: async (text) => {
      await Bun.write(join(root, ".queue.txt"), text);
    },
  };

  const implementer: PipelineStage = {
    name: "fake-implementer",
    enabled: () => true,
    async execute(ctx: PipelineContext): Promise<StageResult> {
      h.calls.push(ctx.story.id);
      const early = await h.onImplement(ctx.story);
      if (early) return early;
      markStoryPassed(ctx.prd, ctx.story.id);
      await savePRD(ctx.prd, ctx.prdPath ?? prdPath);
      return { action: "continue" };
    },
  };

  _iterationRunnerDeps.loadConfigForWorkdir = mock(async () => config);
  _iterationRunnerDeps.runPipeline = mock((_stages, pctx, emitter) =>
    runPipeline([queueCheckStage, implementer], pctx, emitter),
  );
  _unifiedExecutorDeps.runWorkflowPreflight = mock(async () => {});
  _prdCommitDeps.git = mock(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
  _runnerCompletionDeps.runWorkflowFeature = h.runWorkflowFeature;
  _workflowEndReportDeps.readSummary = async () => null;
  _workflowEndReportDeps.saveDuration = async () => true;
  return h;
}

export function packageStory(id: string, pkg: string): UserStory {
  return makeStory({ id, title: `Story ${id}`, workdir: pkg, status: "pending" });
}
