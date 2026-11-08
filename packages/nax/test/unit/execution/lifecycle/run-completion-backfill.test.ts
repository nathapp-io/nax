/**
 * Tests for storyMetrics back-fill behaviour in handleRunCompletion.
 *
 * Back-fill: a story with no entry in allStoryMetrics (resume-run / prior batch, or a story that
 * failed without spending) gets a synthetic StoryMetrics row built from the run-scoped stores, so
 * run.complete analytics and the fallback aggregates see it.
 *
 * Seam coverage (nax#1709) pins the wiring between the pure synthesizer and the aggregate rule:
 * the back-fill reading `runtime.agentFallbacks` for a story
 * that has aggregator cost and NO execution-phase StoryMetrics entry. nax#1707 got that binding
 * wrong (a declared field with no writer), so it must be pinned through the real back-fill.
 *
 * #1721 (closes #1714): the back-fill loop iterated the cost aggregator's keys and skipped
 * anything that did not spend. Two classes of story got no row at all:
 *   - a story that failed having spent nothing (a fallback chain whose candidates all fail auth
 *     instantly), which kept deriveRunFallbackAggregates' exhausted rule unreachable;
 *   - a sibling of a failed batch, whose spend was filed under the batch's LEAD.
 * The domain is now the union of the aggregator's keys, the run-scoped store's keys, and
 * the PRD stories that terminated as an execution failure.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { byCodePoint } from "@nathapp/nax-agent/internal";
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
import { handleRunCompletion, type RunCompletionOptions } from "@/execution/lifecycle/run-completion";
import { pipelineEventBus, type RunCompletedEvent } from "@/pipeline/event-bus";
import type { PRD, UserStory } from "@/prd";
import type { NaxRuntime } from "@/runtime";
import type { CostSnapshot, ICostAggregator } from "@/runtime/cost-aggregator";

// ---------------------------------------------------------------------------
// Helpers — back-fill
// ---------------------------------------------------------------------------

afterEach(() => {
  pipelineEventBus.clear();
  mock.restore();
});

// ---------------------------------------------------------------------------
// Helpers — nax#1709 back-fill seam
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
    totalErrorCostUsd: 0,
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
  execution: { regressionGate: { enabled: false } },
});

const SEAM_WORKDIR = `/tmp/nax-test-1709-seam-${randomUUID()}`;

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

function makeSeamOpts(prd: PRD, runtime: NaxRuntime): RunCompletionOptions {
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
    workdir: SEAM_WORKDIR,
    statusWriter: makeStatusWriter(),
    config: DISABLED_REGRESSION_CONFIG,
    isSequential: true,
    ...makeDispatchContext({ runtime }),
  };
}

function runtimeWith(hops: Record<string, AgentFallbackRecord[]>, storyCosts: Record<string, number>): NaxRuntime {
  const runtime = makeMockRuntime();
  Object.defineProperty(runtime, "costAggregator", {
    value: makeAggregatorWithStoryCost(storyCosts),
    writable: true,
  });
  for (const [id, records] of Object.entries(hops)) runtime.agentFallbacks.set(id, records);
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

/** A PRD of N stories all marked failed — the failed-batch shape. */
function makeFailedBatchPRD(ids: string[]): PRD {
  return makePRDHelper({
    project: "test-project",
    feature: "test-feature",
    branchName: "test-branch",
    userStories: ids.map((id) =>
      makeStory({ id, title: `Story ${id}`, description: "Test story", status: "failed", passes: false, attempts: 2 }),
    ),
  });
}

// ---------------------------------------------------------------------------
// nax#1709 — the back-fill reads the run-scoped store
// ---------------------------------------------------------------------------

describe("handleRunCompletion — nax#1709 back-fill reads the run-scoped store", () => {
  test("a failed story with no execution-phase metric still carries its swap hops", async () => {
    const runtime = runtimeWith({ "US-001": [hop()] }, { "US-001": 1.25 });

    const event = await captureRunCompleted(makeSeamOpts(makeFailedPRD("US-001"), runtime));

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
      { "US-001": 1.25 },
    );

    const event = await captureRunCompleted(makeSeamOpts(makeFailedPRD("US-001"), runtime));

    expect(event?.fallback?.exhaustedStories).toEqual(["US-001"]);
    expect(event?.fallback?.totalHops).toBe(2);
    expect(event?.fallback?.totalWastedCostUsd).toBeCloseTo(0.07, 5);
  });

  test("hops reach the back-filled metric itself", async () => {
    const runtime = runtimeWith({ "US-001": [hop()] }, { "US-001": 1.25 });
    const opts = makeSeamOpts(makeFailedPRD("US-001"), runtime);

    // handleRunCompletion back-fills into options.allStoryMetrics in place.
    await captureRunCompleted(opts);

    const metric = opts.allStoryMetrics.find((m) => m.storyId === "US-001");
    expect(metric).toBeDefined();
    expect(metric?.source).toBe("execution-failed");
    expect(metric?.success).toBe(false);
    expect(metric?.fallback?.hops).toHaveLength(1);
    expect(metric?.fallback?.hops[0].storyId).toBe("US-001");
  });

  test("a story with no recorded swaps produces no fallback aggregate", async () => {
    const runtime = runtimeWith({}, { "US-001": 1.25 });

    const event = await captureRunCompleted(makeSeamOpts(makeFailedPRD("US-001"), runtime));

    expect(event?.fallback).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// nax#1721 (closes #1714) — back-fill domain covers every story that ran
// ---------------------------------------------------------------------------

describe("handleRunCompletion — back-fill domain covers every story that ran (#1721)", () => {
  test("AC-1: a zero-cost failed story with hops still gets a row carrying them", async () => {
    const zeroHop = hop({ costUsd: 0, outcome: "fail-auth" });
    const runtime = runtimeWith({ "US-001": [zeroHop] }, {});
    const opts = makeSeamOpts(makeFailedPRD("US-001"), runtime);

    await captureRunCompleted(opts);

    const metric = opts.allStoryMetrics.find((m) => m.storyId === "US-001");
    expect(metric).toBeDefined();
    expect(metric?.cost).toBe(0);
    expect(metric?.fallback?.hops).toHaveLength(1);
  });

  test("AC-2: the exhausted rule is reachable for a story that spent nothing", async () => {
    const runtime = runtimeWith({ "US-001": [hop({ costUsd: 0, outcome: "fail-auth" })] }, {});

    const event = await captureRunCompleted(makeSeamOpts(makeFailedPRD("US-001"), runtime));

    expect(event?.fallback?.exhaustedStories).toEqual(["US-001"]);
  });

  test("AC-3/AC-4: a failed batch's siblings get rows, not just the lead", async () => {
    // All spend is filed under the lead, matching how the cost aggregator groups a
    // batch: one session, ctx.storyId = US-001.
    const runtime = runtimeWith({}, { "US-001": 3.0 });
    const opts = makeSeamOpts(makeFailedBatchPRD(["US-001", "US-002", "US-003"]), runtime);

    await captureRunCompleted(opts);

    const ids = opts.allStoryMetrics.map((m) => m.storyId).sort(byCodePoint);
    expect(ids).toEqual(["US-001", "US-002", "US-003"]);

    const sibling = opts.allStoryMetrics.find((m) => m.storyId === "US-002");
    expect(sibling?.cost).toBe(0);
    expect(sibling?.source).toBe("execution-failed");
    expect(sibling?.success).toBe(false);
  });

  test("AC-5: a pending story that never ran still gets no row", async () => {
    const prd = makePRDHelper({
      project: "test-project",
      feature: "test-feature",
      branchName: "test-branch",
      userStories: [
        makeStory({ id: "US-001", status: "failed", passes: false, attempts: 2 }),
        makeStory({ id: "US-002", status: "pending", passes: false, attempts: 0 }),
      ],
    });
    const opts = makeSeamOpts(prd, runtimeWith({}, { "US-001": 1.25 }));

    await captureRunCompleted(opts);

    expect(opts.allStoryMetrics.map((m) => m.storyId)).toEqual(["US-001"]);
  });

  test("AC-6: a story already in allStoryMetrics is merged, not duplicated", async () => {
    const opts = makeSeamOpts(makeFailedPRD("US-001"), runtimeWith({}, { "US-001": 5.0 }));
    opts.allStoryMetrics.push({
      storyId: "US-001",
      complexity: "simple",
      modelTier: "balanced",
      modelUsed: "sonnet",
      attempts: 1,
      finalTier: "balanced",
      success: false,
      cost: 1.0,
      durationMs: 10,
      firstPassSuccess: false,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });

    await captureRunCompleted(opts);

    const rows = opts.allStoryMetrics.filter((m) => m.storyId === "US-001");
    expect(rows).toHaveLength(1);
    expect(rows[0].cost).toBe(5.0);
  });
});
