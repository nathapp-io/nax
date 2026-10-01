/**
 * Tests for AC11 of US-002: runExecutionPhase invokes captureRunBaseline exactly
 * once before the first story pipeline dispatch, with the run config and workdir.
 *
 * The capture function is stub-delegated — it writes a single `no-baseline`
 * marker — so the assertions in this file observe the call site and the
 * delegation to `_captureDeps.writeRunBaseline` rather than the not-yet-built
 * capture semantics. The implementer fills in the capture logic; this file
 * stays unchanged.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  makeMockRuntime,
  makeNaxConfig,
  makePluginRegistry,
  makePRD,
  makeStatusWriter,
  makeStory,
} from "@test/helpers";
import { _captureDeps } from "@/execution/lifecycle/test-baseline-capture";
import type { RunnerExecutionOptions } from "@/execution/runner-execution";
import { runExecutionPhase } from "@/execution/runner-execution";
import { _unifiedExecutorDeps } from "@/execution/unified-executor";
import type { UserStory } from "@/prd";

const origRunIteration = _unifiedExecutorDeps.runIteration;
const origRunParallelBatch = _unifiedExecutorDeps.runParallelBatch;
const origSelectIndependentBatch = _unifiedExecutorDeps.selectIndependentBatch;

function makeOptions(overrides: Partial<RunnerExecutionOptions> = {}): RunnerExecutionOptions {
  const runtime = makeMockRuntime();
  return {
    prdPath: "/tmp/nax-runner-exec-capture/prd.json",
    workdir: "/tmp/nax-runner-exec-capture",
    config: makeNaxConfig(),
    hooks: { hooks: {}, _skipGlobal: false },
    feature: "feat-capture",
    featureDir: undefined,
    dryRun: false,
    useBatch: false,
    statusWriter: makeStatusWriter(),
    statusFile: "/tmp/nax-runner-exec-capture/status.json",
    logFilePath: undefined,
    runId: "run-capture",
    startedAt: new Date().toISOString(),
    startTime: Date.now(),
    formatterMode: "quiet",
    headless: false,
    parallel: undefined,
    abortSignal: new AbortController().signal,
    sessionManager: runtime.sessionManager,
    runtime,
    agentManager: runtime.agentManager,
    pluginProviderCache: undefined,
    providerWeightsCache: undefined,
    ...overrides,
  };
}

describe("runExecutionPhase — AC11: invokes captureRunBaseline exactly once", () => {
  afterEach(() => {
    _unifiedExecutorDeps.runIteration = origRunIteration;
    _unifiedExecutorDeps.runParallelBatch = origRunParallelBatch;
    _unifiedExecutorDeps.selectIndependentBatch = origSelectIndependentBatch;
  });

  test("AC11: capture is invoked exactly once before the first story pipeline dispatch with run config + workdir", async () => {
    const writes: Array<{ root: string; featureId: string }> = [];
    _captureDeps.writeRunBaseline = async (root, featureId) => {
      writes.push({ root, featureId });
    };
    // Stub the unified executor's iterators so `executeUnified` returns quickly.
    _unifiedExecutorDeps.runParallelBatch = (async () => ({
      batchResults: [],
      totalCost: 0,
      completed: [] satisfies UserStory[],
      exitReason: "all-stories-passed" as const,
      failed: [],
      mergeConflicts: [],
      storyCosts: new Map(),
    })) as typeof _unifiedExecutorDeps.runParallelBatch;
    _unifiedExecutorDeps.runIteration = (async () => ({
      prd: makePRD({ feature: "feat-capture", userStories: [makeStory({ id: "US-001", status: "passed" })] }),
      storiesCompletedDelta: 0,
      costDelta: 0,
      prdDirty: false,
      finalAction: "continue",
    })) as typeof _unifiedExecutorDeps.runIteration;
    _unifiedExecutorDeps.selectIndependentBatch = (() => []) as typeof _unifiedExecutorDeps.selectIndependentBatch;

    const options = makeOptions();
    await runExecutionPhase(
      options,
      makePRD({ feature: "feat-capture", userStories: [makeStory({ id: "US-001", status: "passed" })] }),
      makePluginRegistry(),
    );

    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual({ root: options.workdir, featureId: options.feature });
  });

  test("AC11 boundary: capture is invoked with the run config and workdir from RunnerExecutionOptions", async () => {
    const writes: Array<{ root: string; featureId: string }> = [];
    _captureDeps.writeRunBaseline = async (root, featureId) => {
      writes.push({ root, featureId });
    };
    _unifiedExecutorDeps.runParallelBatch = (async () => ({
      batchResults: [],
      totalCost: 0,
      completed: [] satisfies UserStory[],
      exitReason: "all-stories-passed" as const,
      failed: [],
      mergeConflicts: [],
      storyCosts: new Map(),
    })) as typeof _unifiedExecutorDeps.runParallelBatch;
    _unifiedExecutorDeps.runIteration = (async () => ({
      prd: makePRD({ feature: "feat-capture", userStories: [makeStory({ id: "US-001", status: "passed" })] }),
      storiesCompletedDelta: 0,
      costDelta: 0,
      prdDirty: false,
      finalAction: "continue",
    })) as typeof _unifiedExecutorDeps.runIteration;
    _unifiedExecutorDeps.selectIndependentBatch = (() => []) as typeof _unifiedExecutorDeps.selectIndependentBatch;

    const workdir = "/tmp/custom-workdir-99";
    const feature = "feat-custom-name";
    await runExecutionPhase(
      makeOptions({ workdir, feature }),
      makePRD({ feature, userStories: [makeStory({ id: "US-001", status: "passed" })] }),
      makePluginRegistry(),
    );

    expect(writes).toHaveLength(1);
    expect(writes[0]?.root).toBe(workdir);
    expect(writes[0]?.featureId).toBe(feature);
  });
});
