import { afterEach, describe, expect, test } from "bun:test";
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
  withDepsRestore,
} from "@test/helpers";
import { stopHeartbeat } from "@/execution/crash-recovery";
import { _endPhaseDeps } from "@/execution/end-phase";
import { _captureDeps } from "@/execution/lifecycle/test-baseline-capture";
import { _runnerDeps, run } from "@/execution/runner";
import { _runnerCompletionDeps } from "@/execution/runner-completion";
import { _unifiedExecutorDeps } from "@/execution/unified-executor";
import { _workflowEndReportDeps } from "@/execution/workflow-end-report";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";
import { pipelineEventBus } from "@/pipeline/event-bus";
import { RunStateKeeper } from "@/runstate";
import { createNoOpCostAggregator } from "@/runtime";
import { SessionManager } from "@/session";
import { _gitDeps } from "@/utils/git";

withDepsRestore(_runnerDeps);
withDepsRestore(_runnerCompletionDeps);
withDepsRestore(_unifiedExecutorDeps);
const originalCaptureDeps = { ..._captureDeps };
withDepsRestore(_endPhaseDeps);
withDepsRestore(_workflowEndReportDeps);
withDepsRestore(_gitDeps);

afterEach(() => {
  Object.assign(_captureDeps, originalCaptureDeps);
  stopHeartbeat();
  pipelineEventBus.clear();
  resetLogger();
});

describe("runner summary", () => {
  test("reports separate completed and gate-open counts from the same run", async () => {
    const workdir = makeTempDir("runner-summary-");
    const config = makeNaxConfig({ execution: { iterationDelayMs: 0 } });
    const sessionManager = new SessionManager();
    const runtime = makeMockRuntime({
      workdir,
      config,
      dryRun: true,
      sessionManager,
      costAggregator: createNoOpCostAggregator(),
    });
    const statusWriter = makeStatusWriter();
    const prd = makePRD({ userStories: [makeStory({ id: "US-001" }), makeStory({ id: "US-002" })] });
    const dispatched: string[] = [];
    const logs: LogEntry[] = [];
    resetLogger();
    initLogger({ level: "silent" });
    addSink((entry) => logs.push(entry));
    _runnerDeps.runSetupPhase = async () => ({
      statusWriter,
      sessionManager,
      cleanupCrashHandlers: () => {},
      pluginRegistry: makePluginRegistry(),
      prd,
      storyCounts: { total: 2, passed: 0, pending: 2, failed: 0 },
      interactionChain: null,
      shutdownController: new AbortController(),
      runtime,
      sealApprovals: async () => {},
    });
    _runnerDeps.activateRunState = async () => ({ keeper: new RunStateKeeper("r", "f"), deactivate: () => {} });
    _runnerDeps.cleanupRun = async () => {};
    _captureDeps.clearStoryBaselines = async () => {};
    _captureDeps.regressionGateEnabled = () => false;
    _captureDeps.writeRunBaseline = async () => {};
    _unifiedExecutorDeps.runWorkflowPreflight = async () => {};
    _unifiedExecutorDeps.runIteration = async (_ctx, currentPrd, selection) => {
      const story = selection.story;
      dispatched.push(story.id);
      story.status = "passed";
      story.passes = true;
      const gateOpen = story.id === "US-002";
      return {
        prd: currentPrd,
        storiesCompletedDelta: gateOpen ? 0 : 1,
        storiesGateOpenDelta: gateOpen ? 1 : 0,
        costDelta: 0,
        prdDirty: false,
      };
    };
    _gitDeps.spawn = makeSpawn().spawn;
    _endPhaseDeps.resolveBranch = async () => "feature/summary";
    _runnerCompletionDeps.runWorkflowFeature = async () => ({
      passed: false,
      outcome: "draft",
      reasons: ["gate open"],
    });
    _workflowEndReportDeps.readSummary = async () => null;
    _workflowEndReportDeps.saveDuration = async () => true;
    try {
      const result = await run({
        prdPath: join(workdir, "prd.json"),
        workdir,
        config,
        hooks: { hooks: {} },
        feature: prd.feature,
        dryRun: false,
        statusFile: join(workdir, "status.json"),
        formatterMode: "quiet",
      });
      const summary = logs.filter(
        (entry) => entry.stage === "run.complete" && entry.message === "Feature execution completed",
      );
      expect(dispatched).toEqual(["US-001", "US-002"]);
      expect(result.storiesCompleted).toBe(1);
      expect(summary).toHaveLength(1);
      expect(summary[0]?.data).toMatchObject({ storiesCompleted: 1, storiesGateOpen: 1, storiesPassed: 2 });
    } finally {
      await runtime.close();
      cleanupTempDir(workdir);
    }
  });
});
