/**
 * Seam test for the nax#1709 parallel wiring in unified-executor.
 *
 * `synthesizeParallelStoryMetric` is unit-tested as a pure function, but nothing
 * exercised the binding that feeds it: unified-executor reading
 * `ctx.runtime.agentFallbacks` / `ctx.runtime.runtimeCrashRetries` after a parallel
 * batch. That binding is the part nax#1709 reported broken (the inline literals read
 * neither store), so it is what has to be pinned — a pure-function test would stay
 * green even if the call site dropped both arguments again.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { makeDispatchContext, makePluginRegistry, makePRD, makeStatusWriter, makeTestRuntime } from "@test/helpers";
import type { AgentFallbackRecord } from "@/agents/manager-types";
import { DEFAULT_CONFIG } from "@/config/defaults";
import { stopHeartbeat } from "@/execution/crash-recovery";
import type { RunParallelBatchResult } from "@/execution/parallel-batch";
import { _unifiedExecutorDeps, executeUnified, type SequentialExecutionContext } from "@/execution/unified-executor";
import type { LoadedHooksConfig } from "@/hooks";
import type { StoryMetrics } from "@/metrics";
import type { PRD, UserStory } from "@/prd/types";
import type { NaxRuntime } from "@/runtime";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const EMPTY_HOOKS: LoadedHooksConfig = { hooks: {} };
const WORKDIR = `/tmp/nax-1709-parallel-seam-${randomUUID()}`;
const PRD_PATH = `/tmp/nax-1709-parallel-seam-prd-${randomUUID()}.json`;

function makePendingStory(id: string): UserStory {
  return {
    id,
    title: `Story ${id}`,
    description: `Description for ${id}`,
    acceptanceCriteria: [],
    tags: [],
    dependencies: [],
    status: "pending",
    passes: false,
    escalations: [],
    attempts: 0,
    priorFailures: [],
  };
}

function makeCtx(runtime: NaxRuntime, config: typeof DEFAULT_CONFIG): SequentialExecutionContext {
  return {
    prdPath: PRD_PATH,
    workdir: WORKDIR,
    config,
    hooks: EMPTY_HOOKS,
    feature: "test-feature",
    dryRun: false,
    useBatch: false,
    parallelCount: 2,
    pluginRegistry: makePluginRegistry(),
    statusWriter: makeStatusWriter(),
    runId: "run-1709-parallel-seam",
    startTime: Date.now(),
    batchPlan: [],
    interactionChain: null,
    logFilePath: undefined,
    ...makeDispatchContext({ runtime }),
  };
}

function hop(overrides: Partial<AgentFallbackRecord> = {}): AgentFallbackRecord {
  return {
    storyId: "US-001",
    priorAgent: "codex",
    newAgent: "claude",
    hop: 1,
    outcome: "fail-quota",
    category: "availability",
    timestamp: "2026-08-26T00:00:00.000Z",
    costUsd: 0.05,
    ...overrides,
  };
}

const origDeps = { ..._unifiedExecutorDeps };

afterEach(() => {
  Object.assign(_unifiedExecutorDeps, origDeps);
  mock.restore();
});

// executeUnified starts a heartbeat that runner.ts normally owns; stop it here
// so the unit suite does not leak parked 60s-timer loops (#1679).
afterEach(() => {
  stopHeartbeat();
});

/**
 * Run one two-story parallel batch that completes, with the given hops and crash
 * retries already recorded on the run-scoped stores (as callOp and
 * handlePipelineFailure would have recorded them during the batch).
 */
async function runCompletedBatch(
  hops: Map<string, AgentFallbackRecord[]>,
  crashes: Map<string, number>,
  /** When set, US-002 comes back as a rectified merge conflict instead of a plain completion. */
  rectifyStory2 = false,
): Promise<StoryMetrics[]> {
  const story1 = makePendingStory("US-001");
  const story2 = makePendingStory("US-002");
  const config = {
    ...DEFAULT_CONFIG,
    execution: { ...DEFAULT_CONFIG.execution, maxIterations: 1, iterationDelayMs: 0 },
  };
  const runtime = makeTestRuntime({ config });
  for (const [id, records] of hops) runtime.agentFallbacks.set(id, records);
  for (const [id, n] of crashes) runtime.runtimeCrashRetries.set(id, n);

  _unifiedExecutorDeps.selectIndependentBatch = () => [story1, story2];
  _unifiedExecutorDeps.runParallelBatch = async (): Promise<RunParallelBatchResult> => ({
    completed: rectifyStory2 ? [story1] : [story1, story2],
    failed: [],
    mergeConflicts: rectifyStory2 ? [{ story: story2, rectified: true, cost: 0.5 }] : [],
    storyCosts: new Map([
      [story1.id, 1],
      [story2.id, 1],
    ]),
    totalCost: 2,
  });

  const prd: PRD = makePRD({
    project: "test-project",
    feature: "test-feature",
    branchName: "test-branch",
    userStories: [story1, story2],
  });

  const result = await executeUnified(makeCtx(runtime, config), prd);
  return result.allStoryMetrics;
}

const metricFor = (metrics: StoryMetrics[], id: string): StoryMetrics | undefined =>
  metrics.find((m) => m.storyId === id);

// ---------------------------------------------------------------------------

describe("executeUnified — nax#1709 parallel metrics read the run-scoped stores", () => {
  test("a completed parallel story carries the hops callOp recorded for it", async () => {
    const metrics = await runCompletedBatch(
      new Map([["US-001", [hop(), hop({ hop: 2, priorAgent: "claude", newAgent: "opencode", costUsd: 0.02 })]]]),
      new Map(),
    );

    const lead = metricFor(metrics, "US-001");
    expect(lead?.fallback?.hops).toHaveLength(2);
    expect(lead?.fallback?.hops[1].newAgent).toBe("opencode");
    expect(lead?.source).toBe("parallel");
  });

  test("a parallel story with no recorded swaps carries no fallback field", async () => {
    const metrics = await runCompletedBatch(new Map([["US-001", [hop()]]]), new Map());

    expect(metricFor(metrics, "US-002")?.fallback).toBeUndefined();
  });

  test("a rectified merge-conflict story reads both stores at its own call site", async () => {
    // unified-executor builds the rectification metric at a SECOND call site; dropping
    // the store reads there would leave the completion-path tests above green.
    const metrics = await runCompletedBatch(
      new Map([["US-002", [hop({ storyId: "US-002" })]]]),
      new Map([["US-002", 1]]),
      true,
    );

    const rectified = metricFor(metrics, "US-002");
    expect(rectified?.source).toBe("rectification");
    expect(rectified?.rectificationCost).toBe(0.5);
    expect(rectified?.fallback?.hops).toHaveLength(1);
    expect(rectified?.runtimeCrashes).toBe(1);
  });

  test("crash retries reach the parallel metric instead of a hardcoded zero", async () => {
    const metrics = await runCompletedBatch(new Map(), new Map([["US-002", 2]]));

    expect(metricFor(metrics, "US-002")?.runtimeCrashes).toBe(2);
    expect(metricFor(metrics, "US-001")?.runtimeCrashes).toBe(0);
  });
});
