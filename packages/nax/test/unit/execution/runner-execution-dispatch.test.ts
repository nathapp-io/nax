import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  assertDefined,
  cleanupTempDir,
  makeDispatchContext,
  makeMockRuntime,
  makeNaxConfig,
  makePluginRegistry,
  makePRD,
  makeStatusWriter,
  makeStory,
  makeTempDir,
  withDepsRestore,
} from "@test/helpers";
import { stopHeartbeat } from "@/execution/crash-recovery";
import type { SequentialExecutionContext } from "@/execution/executor-types";
import { _captureDeps } from "@/execution/lifecycle/test-baseline-capture";
import { _runnerDeps, run } from "@/execution/runner";
import { type RunnerExecutionOptions, runExecutionPhase } from "@/execution/runner-execution";
import { _unifiedExecutorDeps } from "@/execution/unified-executor";
import { getLogger } from "@/logger";
import { RunStateKeeper } from "@/runstate";
import { SessionManager } from "@/session";

describe("workflow harness dispatch", () => {
  withDepsRestore(_captureDeps);
  withDepsRestore(_unifiedExecutorDeps);
  withDepsRestore(_runnerDeps);
  let workdir: string;
  let warnings: string[];
  let restoreWarn: () => void;
  let dispatches: string[][];
  let contexts: RunnerExecutionOptions[];
  let executorContexts: SequentialExecutionContext[];

  beforeEach(() => {
    workdir = makeTempDir("nax-dispatch-");
    warnings = [];
    dispatches = [];
    contexts = [];
    executorContexts = [];
    const warn = spyOn(getLogger(), "warn").mockImplementation((_stage, message) => {
      warnings.push(message);
    });
    restoreWarn = () => warn.mockRestore();
    _captureDeps.clearStoryBaselines = async () => {};
    _captureDeps.regressionGateEnabled = () => false;
    _captureDeps.writeRunBaseline = async () => {};
    _unifiedExecutorDeps.runWorkflowPreflight = async () => {};
    _unifiedExecutorDeps.runIteration = async (ctx, prd, selection) => {
      dispatches.push(selection.storiesToExecute.map((s) => s.id));
      // Capture the actual executor context, including property absence.
      executorContexts.push(ctx);
      for (const story of selection.storiesToExecute) {
        story.status = "passed";
        story.passes = true;
      }
      return { prd, storiesCompletedDelta: selection.storiesToExecute.length, costDelta: 0, prdDirty: false };
    };
  });

  afterEach(() => {
    restoreWarn();
    stopHeartbeat();
    cleanupTempDir(workdir);
  });

  function options(mode: "workflow" | "pipeline" = "workflow"): RunnerExecutionOptions {
    return {
      ...makeDispatchContext({ runtime: makeMockRuntime({ workdir }) }),
      config: makeNaxConfig({ acceptance: { enabled: false }, execution: { mode, iterationDelayMs: 0 } }),
      prdPath: `${workdir}/prd.json`,
      workdir,
      feature: "dispatch",
      dryRun: false,
      useBatch: true,
      parallel: 4,
      hooks: { hooks: {} },
      statusWriter: makeStatusWriter(),
      statusFile: `${workdir}/status.json`,
      runId: "dispatch-run",
      startedAt: new Date().toISOString(),
      startTime: Date.now(),
      formatterMode: "quiet",
      headless: false,
    };
  }

  function prd() {
    return makePRD({ userStories: [makeStory({ id: "US-001" }), makeStory({ id: "US-002" })] });
  }

  test.each(["workflow", "pipeline"] as const)(
    "AC-5/6: runExecutionPhase with %s config dispatches one story at a time without ignored-option warnings or parallelCount",
    async (mode) => {
      const result = await runExecutionPhase(options(mode), prd(), makePluginRegistry());
      expect(warnings.filter((m) => m.includes("story batching disabled") || m.includes("--parallel"))).toEqual([]);
      expect(result.storiesCompleted).toBe(2);
      expect(dispatches).toEqual([["US-001"], ["US-002"]]);
      expect(executorContexts.map((ctx) => ctx.useBatch)).toEqual([false, false]);
      expect(executorContexts.map((ctx) => Object.hasOwn(ctx, "parallelCount"))).toEqual([false, false]);
    },
  );

  test.each(["workflow", "pipeline"] as const)(
    "AC-7: run with %s config ignores useBatch true silently and executes unbatched",
    async (mode) => {
      const opts = options(mode);
      const initialPrd = prd();
      const runtime = opts.runtime;
      _runnerDeps.runSetupPhase = async () => ({
        statusWriter: opts.statusWriter,
        sessionManager: new SessionManager(),
        cleanupCrashHandlers: () => {},
        pluginRegistry: makePluginRegistry(),
        prd: initialPrd,
        storyCounts: { total: 2, passed: 0, pending: 2, failed: 0 },
        interactionChain: null,
        shutdownController: new AbortController(),
        runtime,
        sealApprovals: async () => {},
      });
      _runnerDeps.activateRunState = async () => ({ keeper: new RunStateKeeper("r", "f"), deactivate: () => {} });
      _runnerDeps.cleanupRun = async () => {};
      _runnerDeps.runCompletionPhase = async () => ({
        durationMs: 1,
        runCompletedAt: "now",
        acceptancePassed: true,
        pluginGateFailed: false,
        reportedTotal: 0,
      });
      _runnerDeps.runExecutionPhase = async (input, inputPrd, registry) => {
        contexts.push(input);
        return runExecutionPhase(input, inputPrd, registry);
      };
      const result = await run(opts);
      expect(warnings.filter((m) => m.includes("story batching disabled"))).toEqual([]);
      expect(result.storiesCompleted).toBe(2);
      assertDefined(contexts[0], "execution options from run");
      expect(contexts[0].useBatch).toBe(false);
      expect(dispatches).toEqual([["US-001"], ["US-002"]]);
      expect(executorContexts.map((ctx) => ctx.useBatch)).toEqual([false, false]);
      expect(executorContexts.map((ctx) => Object.hasOwn(ctx, "parallelCount"))).toEqual([false, false]);
    },
  );
});
