/**
 * Regression tests for Bug 909 — completion-phase agent calls (acceptance /
 * hardening / diagnosis / fix-cycle) were silently dropped from run totalCost.
 *
 * Root cause: handleRunCompletion only counted execution-phase cost accumulated
 * in the local `totalCost` counter. The runtime.costAggregator already captured
 * the completion-phase spend via dispatch events, but nobody read it.
 *
 * Fix: handleRunCompletion now reads costAggregator.snapshot() and uses
 * Math.max(localTotal, aggregatorTotal) as the authoritative reported total.
 * It also back-fills storyMetrics for stories that only had completion-phase spend.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { NaxConfig } from "../../../../src/config";
import {
  type RunCompletionOptions,
  _runCompletionDeps,
  handleRunCompletion,
} from "../../../../src/execution/lifecycle/run-completion";
import type { ICostAggregator, CostSnapshot } from "../../../../src/runtime/cost-aggregator";
import type { StoryMetrics } from "../../../../src/metrics";
import { pipelineEventBus } from "../../../../src/pipeline/event-bus";
import type { RunCompletedEvent } from "../../../../src/pipeline/event-bus";
import type { PRD } from "../../../../src/prd";
import { makeNaxConfig, makeMockRuntime, makePRD as makePRDHelper, makeStory } from "../../../helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePRD(ids: string[]): PRD {
  return makePRDHelper({
    project: "test-project",
    feature: "test-feature",
    branchName: "test-branch",
    userStories: ids.map((id) =>
      makeStory({ id, title: `Story ${id}`, description: "Test story", status: "passed", passes: true, attempts: 1 }),
    ),
  });
}

function makeEmptySnapshot(): CostSnapshot {
  return { totalCostUsd: 0, totalEstimatedCostUsd: 0, totalInputTokens: 0, totalOutputTokens: 0, callCount: 0, errorCount: 0 };
}

function makeMockAggregator(overrides: Partial<ICostAggregator> = {}): ICostAggregator {
  return {
    record: () => {},
    recordError: () => {},
    recordOperationSummary: () => {},
    snapshot: () => makeEmptySnapshot(),
    byAgent: () => ({}),
    byStage: () => ({}),
    byStory: () => ({}),
    drain: async () => {},
    ...overrides,
  };
}

function makeStatusWriter() {
  return {
    setPrd: mock(() => {}),
    setCurrentStory: mock(() => {}),
    setRunStatus: mock(() => {}),
    setPostRunPhase: mock(() => {}),
    update: mock(async () => {}),
  };
}

const DISABLED_REGRESSION_CONFIG: NaxConfig = makeNaxConfig({
  execution: {
    regressionGate: { enabled: false, mode: "disabled" },
  },
});

const WORKDIR = `/tmp/nax-test-aggregator-${randomUUID()}`;

function makeOpts(
  prd: PRD,
  metrics: StoryMetrics[],
  aggregator: ICostAggregator,
  totalCost = 0,
): RunCompletionOptions {
  const runtime = makeMockRuntime();
  // Override costAggregator with our controlled mock
  Object.defineProperty(runtime, "costAggregator", { value: aggregator, writable: true });
  return {
    runId: "run-001",
    feature: "test-feature",
    startedAt: new Date().toISOString(),
    prd,
    allStoryMetrics: metrics,
    totalCost,
    storiesCompleted: metrics.length,
    iterations: 1,
    startTime: Date.now() - 1000,
    workdir: WORKDIR,
    statusWriter: makeStatusWriter() as unknown as RunCompletionOptions["statusWriter"],
    config: DISABLED_REGRESSION_CONFIG,
    runtime,
  };
}

const origDeps = { ..._runCompletionDeps };

afterEach(() => {
  Object.assign(_runCompletionDeps, origDeps);
  pipelineEventBus.clear();
  mock.restore();
});

// ---------------------------------------------------------------------------
// Bug 909 — aggregator-driven totalCost reporting
// ---------------------------------------------------------------------------

describe("handleRunCompletion — Bug 909: aggregator-driven totalCost reporting", () => {
  test("reports max(legacyTotalCost, aggregatorTotal) when aggregator sees more spend", async () => {
    const prd = makePRD(["US-001"]);
    const aggregator = makeMockAggregator({
      snapshot: () => ({ ...makeEmptySnapshot(), totalCostUsd: 6.21, totalEstimatedCostUsd: 6.21, callCount: 5 }),
      byStage: () => ({ acceptance: { ...makeEmptySnapshot(), totalCostUsd: 5.42, callCount: 3 } }),
      byStory: () => ({ "US-001": { ...makeEmptySnapshot(), totalCostUsd: 6.21, callCount: 5 } }),
    });

    let capturedEvent: RunCompletedEvent | undefined;
    pipelineEventBus.on("run:completed", (e) => { capturedEvent = e; });

    await handleRunCompletion(makeOpts(prd, [], aggregator, 0));

    expect(capturedEvent?.totalCost).toBeCloseTo(6.21, 2);
  });

  test("uses legacyTotalCost when it exceeds the aggregator total", async () => {
    const prd = makePRD(["US-001"]);
    const aggregator = makeMockAggregator({
      snapshot: () => ({ ...makeEmptySnapshot(), totalCostUsd: 1.0, callCount: 1 }),
      byStory: () => ({ "US-001": { ...makeEmptySnapshot(), totalCostUsd: 1.0, callCount: 1 } }),
    });

    let capturedEvent: RunCompletedEvent | undefined;
    pipelineEventBus.on("run:completed", (e) => { capturedEvent = e; });

    await handleRunCompletion(makeOpts(prd, [], aggregator, 3.5));

    expect(capturedEvent?.totalCost).toBeCloseTo(3.5, 2);
  });

  test("back-fills storyMetrics for stories with only completion-phase spend", async () => {
    const prd = makePRD(["US-001", "US-007"]);
    const aggregator = makeMockAggregator({
      snapshot: () => ({ ...makeEmptySnapshot(), totalCostUsd: 2.81, callCount: 3 }),
      byStory: () => ({
        "US-001": { ...makeEmptySnapshot(), totalCostUsd: 2.71, callCount: 2 },
        "US-007": { ...makeEmptySnapshot(), totalCostUsd: 0.10, callCount: 1 },
      }),
    });

    const metrics: StoryMetrics[] = [];
    await handleRunCompletion(makeOpts(prd, metrics, aggregator));

    expect(metrics).toHaveLength(2);
    const us001 = metrics.find((m) => m.storyId === "US-001");
    expect(us001?.cost).toBeCloseTo(2.71, 2);
    expect(us001?.source).toBe("completion-phase");
    const us007 = metrics.find((m) => m.storyId === "US-007");
    expect(us007?.cost).toBeCloseTo(0.10, 2);
    expect(us007?.source).toBe("completion-phase");
  });

  test("does not inject a storyMetrics entry for stories with zero aggregator cost", async () => {
    const prd = makePRD(["US-001"]);
    const aggregator = makeMockAggregator({
      snapshot: () => makeEmptySnapshot(),
      byStory: () => ({ "US-001": makeEmptySnapshot() }),
    });

    const metrics: StoryMetrics[] = [];
    await handleRunCompletion(makeOpts(prd, metrics, aggregator));

    expect(metrics).toHaveLength(0);
  });

  test("does not double-count when execution-phase already reported cost for a story", async () => {
    const prd = makePRD(["US-001"]);
    // Aggregator says US-001 spent $3.50 total; execution-phase already logged $1.00
    const aggregator = makeMockAggregator({
      snapshot: () => ({ ...makeEmptySnapshot(), totalCostUsd: 3.5, callCount: 3 }),
      byStory: () => ({ "US-001": { ...makeEmptySnapshot(), totalCostUsd: 3.5, callCount: 3 } }),
    });

    const existingMetrics: StoryMetrics[] = [{
      storyId: "US-001",
      complexity: "medium",
      modelTier: "balanced",
      modelUsed: "claude",
      attempts: 1,
      finalTier: "balanced",
      success: true,
      cost: 1.0,
      durationMs: 2000,
      firstPassSuccess: true,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      runtimeCrashes: 0,
    }];

    await handleRunCompletion(makeOpts(prd, existingMetrics, aggregator, 1.0));

    // Aggregator total replaces the existing cost — no double-add
    expect(existingMetrics).toHaveLength(1);
    expect(existingMetrics[0].cost).toBeCloseTo(3.5, 2);
    // Source stays unchanged (this is an existing execution-phase entry)
    expect(existingMetrics[0].source).toBeUndefined();
  });

  test("keeps existing story cost when aggregator total is lower", async () => {
    const prd = makePRD(["US-001"]);
    // Aggregator only saw $0.50, execution-phase reported $1.00
    const aggregator = makeMockAggregator({
      snapshot: () => ({ ...makeEmptySnapshot(), totalCostUsd: 0.5, callCount: 1 }),
      byStory: () => ({ "US-001": { ...makeEmptySnapshot(), totalCostUsd: 0.5, callCount: 1 } }),
    });

    const existingMetrics: StoryMetrics[] = [{
      storyId: "US-001",
      complexity: "medium",
      modelTier: "balanced",
      modelUsed: "claude",
      attempts: 1,
      finalTier: "balanced",
      success: true,
      cost: 1.0,
      durationMs: 2000,
      firstPassSuccess: true,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      runtimeCrashes: 0,
    }];

    await handleRunCompletion(makeOpts(prd, existingMetrics, aggregator, 1.0));

    // Aggregator is lower — keep the existing cost
    expect(existingMetrics[0].cost).toBeCloseTo(1.0, 2);
  });

  test("emits costByStage and costByStory in run:completed event when aggregator has data", async () => {
    const prd = makePRD(["US-001"]);
    const aggregator = makeMockAggregator({
      snapshot: () => ({ ...makeEmptySnapshot(), totalCostUsd: 5.42, callCount: 3 }),
      byStage: () => ({ acceptance: { ...makeEmptySnapshot(), totalCostUsd: 5.42, callCount: 3 } }),
      byStory: () => ({ "US-001": { ...makeEmptySnapshot(), totalCostUsd: 5.42, callCount: 3 } }),
    });

    let capturedEvent: RunCompletedEvent | undefined;
    pipelineEventBus.on("run:completed", (e) => { capturedEvent = e; });

    await handleRunCompletion(makeOpts(prd, [], aggregator, 0));

    // The totalCost on the event should be the aggregator total
    expect(capturedEvent?.totalCost).toBeCloseTo(5.42, 2);
  });
});
