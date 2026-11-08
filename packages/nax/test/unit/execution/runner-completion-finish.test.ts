/** Feature-workflow placement, persistence and post-run interaction wiring. */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  cleanupTempDir,
  makeDispatchContext,
  makePRD as makeFixturePRD,
  makeStory as makeFixtureStory,
  makeMockRuntime,
  makeNaxConfig,
  makeSpawn,
  makeStatusWriter,
  makeTempDir,
  makeTestRuntime,
} from "@test/helpers";
import type { NaxConfig } from "@/config";
import type { RunCompletionOptions, RunCompletionResult } from "@/execution/lifecycle/run-completion";
import { _runnerCompletionDeps, type RunnerCompletionOptions, runCompletionPhase } from "@/execution/runner-completion";
import { StatusWriter } from "@/execution/status-writer";
import type { LoadedHooksConfig } from "@/hooks";
import { InteractionChain } from "@/interaction";
import { pipelineEventBus } from "@/pipeline/event-bus";
import { PluginRegistry } from "@/plugins";
import type { PRD, UserStory } from "@/prd";
import { _gitDeps } from "@/utils/git";
import type { WorkflowFeatureInput } from "@/workflow";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePRD(stories: Array<{ id: string; status: UserStory["status"] }>): PRD {
  return makeFixturePRD({
    userStories: stories.map(({ id, status }) => makeFixtureStory({ id, status, passes: status === "passed" })),
  });
}

function makeConfig(acceptanceEnabled = true): NaxConfig {
  return makeNaxConfig({
    acceptance: {
      enabled: acceptanceEnabled,
      maxRetries: 3,
    },
    execution: {
      mode: "pipeline",
    },
  });
}

const WORKDIR = `/tmp/nax-test-runner-completion-finish-${randomUUID()}`;

function makeOpts(
  config: NaxConfig,
  prd: PRD,
  statusWriter: ReturnType<typeof makeStatusWriter>,
): RunnerCompletionOptions {
  return {
    config,
    hooks: { hooks: {}, _skipGlobal: false } satisfies LoadedHooksConfig,
    feature: "test-feature",
    workdir: WORKDIR,
    statusFile: `${WORKDIR}/status.json`,
    logFilePath: undefined,
    runId: "run-001",
    startedAt: new Date().toISOString(),
    startTime: Date.now() - 1000,
    formatterMode: "quiet",
    headless: false,
    prd,
    allStoryMetrics: [],
    totalCost: 0,
    storiesCompleted: 1,
    iterations: 1,
    statusWriter,
    pluginRegistry: new PluginRegistry([]),
    prdPath: `${WORKDIR}/prd.json`,
    ...makeDispatchContext(),
  };
}

// Default mock for handleRunCompletion (no regression)
const defaultCompletionResult: RunCompletionResult = {
  durationMs: 100,
  runCompletedAt: new Date().toISOString(),
  reportedTotal: 0,
  pluginGateFailed: false,
  finalCounts: { total: 1, passed: 1, failed: 0, skipped: 0, pending: 0 },
};

const runtimes: ReturnType<typeof makeTestRuntime>[] = [];
const origDeps = { ..._runnerCompletionDeps };

beforeEach(() => {
  _runnerCompletionDeps.runWorkflowFeature = mock(async () => null);
  _runnerCompletionDeps.handleRunCompletion = mock(async () => defaultCompletionResult);
  _runnerCompletionDeps.loadConfigForPackage = mock(async () => makeConfig(true));
});

afterEach(async () => {
  await Promise.allSettled(runtimes.map((r) => r.close()));
  runtimes.length = 0;
  Object.assign(_runnerCompletionDeps, origDeps);
  pipelineEventBus.clear();
  mock.restore();
});

// ---------------------------------------------------------------------------
// Feature workflow placement and spend persistence
// ---------------------------------------------------------------------------

/** A real tracked runtime to observe close ordering. */
function makeOptsWithRuntime(
  config: NaxConfig,
  prd: PRD,
  statusWriter: ReturnType<typeof makeStatusWriter>,
): RunnerCompletionOptions {
  const runtime = makeTestRuntime({ config });
  runtimes.push(runtime);
  return {
    ...makeOpts(config, prd, statusWriter),
    ...makeDispatchContext({ runtime }),
  };
}

describe("feature workflow placement", () => {
  test("runs before the runtime is closed", async () => {
    const order: string[] = [];
    _runnerCompletionDeps.runWorkflowFeature = mock(async () => {
      order.push("workflow");
      return null;
    });
    const opts = makeOptsWithRuntime(
      makeConfig(false),
      makePRD([{ id: "US-001", status: "passed" }]),
      makeStatusWriter(),
    );
    const close = opts.runtime.close.bind(opts.runtime);
    opts.runtime.close = async () => {
      order.push("close");
      await close();
    };
    await runCompletionPhase(opts);
    expect(order).toEqual(["workflow", "close"]);
  });

  test("persists successful and failed-dispatch spend after the workflow", async () => {
    const dir = makeTempDir("workflow-persistence-");
    const config = makeConfig(false);
    const prd = makePRD([{ id: "US-001", status: "passed" }]);
    const writer = new StatusWriter(join(dir, "status.json"), config, {
      runId: "run-001",
      feature: "test-feature",
      startedAt: new Date().toISOString(),
      dryRun: false,
      startTimeMs: Date.now(),
      pid: process.pid,
    });
    writer.setPrd(prd);
    const runtime = makeMockRuntime({ config, workdir: dir });
    _runnerCompletionDeps.runWorkflowFeature = mock(async () => {
      runtime.costAggregator.record({
        ts: Date.now(),
        runId: "run-001",
        agentName: "native",
        model: "test",
        estimatedCostUsd: 0.06,
        exactCostUsd: 0.06,
        costUsd: 0.06,
        confidence: "exact",
        durationMs: 1,
      });
      runtime.costAggregator.recordError({
        kind: "error",
        ts: Date.now(),
        runId: "run-001",
        agentName: "native",
        errorCode: "DISPATCH_FAILED",
        durationMs: 1,
        costUsd: 0.0228,
      });
      return null;
    });
    const originalSpawn = _gitDeps.spawn;
    _gitDeps.spawn = makeSpawn().spawn;
    try {
      const result = await runCompletionPhase({
        ...makeOpts(config, prd, makeStatusWriter()),
        workdir: dir,
        statusWriter: writer,
        ...makeDispatchContext({ runtime }),
      });
      expect(result.reportedTotal).toBeCloseTo(0.0828, 4);
      expect((await Bun.file(join(dir, "status.json")).json()).cost.spent).toBeCloseTo(0.0828, 4);
    } finally {
      _gitDeps.spawn = originalSpawn;
      await runtime.close();
      cleanupTempDir(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// #2201: every post-run dispatching site gets the run's interaction chain.
// ---------------------------------------------------------------------------

describe("post-run ask wiring inputs (#2201)", () => {
  test("the interaction chain reaches completion and workflow", async () => {
    const prd = makePRD([{ id: "US-001", status: "passed" }]);
    const chain = new InteractionChain({ defaultTimeout: 1000, defaultFallback: "abort" });
    const completionOpts: RunCompletionOptions[] = [];
    const workflowCtxs: WorkflowFeatureInput[] = [];
    _runnerCompletionDeps.handleRunCompletion = mock(async (opts: RunCompletionOptions) => {
      completionOpts.push(opts);
      return defaultCompletionResult;
    });
    _runnerCompletionDeps.runWorkflowFeature = mock(async (ctx: WorkflowFeatureInput) => {
      workflowCtxs.push(ctx);
      return null;
    });

    await runCompletionPhase({
      ...makeOptsWithRuntime(makeConfig(true), prd, makeStatusWriter()),
      interactionChain: chain,
    });

    expect(completionOpts[0]?.interactionChain).toBe(chain);
    expect(workflowCtxs[0]?.interactionChain).toBe(chain);
  });
});
