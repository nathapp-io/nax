/**
 * Seam tests for the nax#1709 back-fill wiring in handleRunCompletion.
 *
 * The pure synthesizer (`synthesizeBackfillMetric`) is unit-tested in
 * backfill-story-metrics.test.ts, and the aggregate rule is unit-tested in
 * fallback-aggregates.test.ts — but nothing exercised the binding between them:
 * `run-completion.ts` reading `runtime.agentFallbacks` / `runtime.runtimeCrashRetries`
 * for a story that has aggregator cost and NO execution-phase StoryMetrics entry.
 *
 * That binding is exactly what nax#1707 got wrong (a declared field with no writer),
 * so it is the part that must be pinned by a test that goes through the real
 * back-fill rather than handing a pre-built metric to `allStoryMetrics`.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  makeDispatchContext,
  makeMockRuntime,
  makeNaxConfig,
  makePRD as makePRDHelper,
  makeStatusWriter,
  makeStory,
} from "@test/helpers";
import type { AgentFallbackRecord } from "@/agents/manager-types";
import type { NaxConfig } from "@/config";
import {
  _runCompletionDeps,
  handleRunCompletion,
  type RunCompletionOptions,
} from "@/execution/lifecycle/run-completion";
import type { RunCompletedEvent } from "@/pipeline/event-bus";
import { pipelineEventBus } from "@/pipeline/event-bus";
import type { PRD, UserStory } from "@/prd";
import type { NaxRuntime } from "@/runtime";
import type { CostSnapshot, ICostAggregator } from "@/runtime/cost-aggregator";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEmptySnapshot(): CostSnapshot {
  return {
    totalCostUsd: 0,
    totalEstimatedCostUsd: 0,
    totalExactCostUsd: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    callCount: 0,
    errorCount: 0,
  };
}

/** An aggregator that reports per-story spend but no execution-phase metric exists for it. */
function makeAggregatorWithStoryCost(byStory: Record<string, number>): ICostAggregator {
  const total = Object.values(byStory).reduce((a, b) => a + b, 0);
  const stories = Object.fromEntries(
    Object.entries(byStory).map(([id, cost]) => [id, { ...makeEmptySnapshot(), totalCostUsd: cost, callCount: 1 }]),
  );
  return {
    record: () => {},
    recordError: () => {},
    recordOperationSummary: () => {},
    snapshot: () => ({ ...makeEmptySnapshot(), totalCostUsd: total, callCount: 1 }),
    byAgent: () => ({}),
    byStage: () => ({}),
    byStory: () => stories,
    byCall: () => ({}),
    byScope: () => ({}),
    openScope: (scopeId = "test-scope") => ({ scopeId, snapshot: () => makeEmptySnapshot(), close: () => {} }),
    drain: async () => {},
  };
}

const DISABLED_REGRESSION_CONFIG: NaxConfig = makeNaxConfig({
  execution: { regressionGate: { enabled: false, mode: "disabled" } },
});

const WORKDIR = `/tmp/nax-test-1709-seam-${randomUUID()}`;

function makeFailedPRD(id: string): PRD {
  const story: UserStory = makeStory({
    id,
    title: `Story ${id}`,
    description: "Test story",
    status: "failed",
    passes: false,
    attempts: 2,
  });
  return makePRDHelper({
    project: "test-project",
    feature: "test-feature",
    branchName: "test-branch",
    userStories: [story],
  });
}

function makeOpts(prd: PRD, runtime: NaxRuntime): RunCompletionOptions {
  return {
    runId: "run-001",
    feature: "test-feature",
    startedAt: new Date().toISOString(),
    prd,
    // Empty: the story failed in the execution stage, so it never reached the
    // completion stage and has no execution-phase metric. This is the case the
    // back-fill exists for.
    allStoryMetrics: [],
    totalCost: 0,
    storiesCompleted: 0,
    iterations: 1,
    startTime: Date.now() - 1000,
    workdir: WORKDIR,
    statusWriter: makeStatusWriter(),
    config: DISABLED_REGRESSION_CONFIG,
    isSequential: true,
    ...makeDispatchContext({ runtime }),
  };
}

function runtimeWith(
  hops: Record<string, AgentFallbackRecord[]>,
  crashes: Record<string, number>,
  storyCosts: Record<string, number>,
): NaxRuntime {
  const runtime = makeMockRuntime();
  Object.defineProperty(runtime, "costAggregator", {
    value: makeAggregatorWithStoryCost(storyCosts),
    writable: true,
  });
  for (const [id, records] of Object.entries(hops)) runtime.agentFallbacks.set(id, records);
  for (const [id, n] of Object.entries(crashes)) runtime.runtimeCrashRetries.set(id, n);
  return runtime;
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

const origDeps = { ..._runCompletionDeps };

afterEach(() => {
  Object.assign(_runCompletionDeps, origDeps);
  pipelineEventBus.clear();
  mock.restore();
});

async function captureRunCompleted(opts: RunCompletionOptions): Promise<RunCompletedEvent | undefined> {
  let captured: RunCompletedEvent | undefined;
  const unsub = pipelineEventBus.on("run:completed", (e) => {
    captured = e;
  });
  try {
    await handleRunCompletion(opts);
  } finally {
    unsub();
  }
  return captured;
}

// ---------------------------------------------------------------------------

describe("handleRunCompletion — nax#1709 back-fill reads the run-scoped stores", () => {
  test("a failed story with no execution-phase metric still carries its swap hops", async () => {
    const runtime = runtimeWith({ "US-001": [hop()] }, {}, { "US-001": 1.25 });

    const event = await captureRunCompleted(makeOpts(makeFailedPRD("US-001"), runtime));

    expect(event?.fallback).toBeDefined();
    expect(event?.fallback?.totalHops).toBe(1);
    expect(event?.fallback?.perPair).toEqual({ "codex->claude": 1 });
    expect(event?.fallback?.totalWastedCostUsd).toBeCloseTo(0.05, 5);
  });

  test("the exhausted rule fires for a story built by the real back-fill", async () => {
    // Agent A hits fail-quota, swaps to B, B is also unavailable, the op throws and
    // the story fails — the failure scenario the issue named.
    const runtime = runtimeWith(
      {
        "US-001": [
          hop({ priorAgent: "codex", newAgent: "claude", hop: 1, costUsd: 0.05 }),
          hop({ priorAgent: "claude", newAgent: "opencode", hop: 2, outcome: "fail-service-down", costUsd: 0.02 }),
        ],
      },
      {},
      { "US-001": 1.25 },
    );

    const event = await captureRunCompleted(makeOpts(makeFailedPRD("US-001"), runtime));

    expect(event?.fallback?.exhaustedStories).toEqual(["US-001"]);
    expect(event?.fallback?.totalHops).toBe(2);
    expect(event?.fallback?.totalWastedCostUsd).toBeCloseTo(0.07, 5);
  });

  test("crash retries and hops reach the back-filled metric itself", async () => {
    const runtime = runtimeWith({ "US-001": [hop()] }, { "US-001": 3 }, { "US-001": 1.25 });
    const opts = makeOpts(makeFailedPRD("US-001"), runtime);

    // handleRunCompletion back-fills into options.allStoryMetrics in place.
    await captureRunCompleted(opts);

    const metric = opts.allStoryMetrics.find((m) => m.storyId === "US-001");
    expect(metric).toBeDefined();
    expect(metric?.source).toBe("execution-failed");
    expect(metric?.success).toBe(false);
    expect(metric?.runtimeCrashes).toBe(3);
    expect(metric?.fallback?.hops).toHaveLength(1);
    expect(metric?.fallback?.hops[0].storyId).toBe("US-001");
  });

  test("a story with no recorded swaps produces no fallback aggregate", async () => {
    const runtime = runtimeWith({}, {}, { "US-001": 1.25 });

    const event = await captureRunCompleted(makeOpts(makeFailedPRD("US-001"), runtime));

    expect(event?.fallback).toBeUndefined();
  });
});
