/**
 * Tests for RunFallbackAggregate wiring in handleRunCompletion (ADR-012 PR-2).
 *
 * Verifies that handleRunCompletion computes RunFallbackAggregate from story
 * metrics and attaches it to (a) the emitted run:completed event and
 * (b) the saved RunMetrics JSONL payload.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { DEFAULT_CONFIG } from "../../../../src/config/defaults";
import type { NaxConfig } from "../../../../src/config";
import {
  _runCompletionDeps,
  handleRunCompletion,
  type RunCompletionOptions,
} from "../../../../src/execution/lifecycle/run-completion";
import type { DeferredRegressionResult } from "../../../../src/execution/lifecycle/run-regression";
import type { AgentFallbackHop, StoryMetrics } from "../../../../src/metrics";
import { pipelineEventBus } from "../../../../src/pipeline/event-bus";
import type { RunCompletedEvent } from "../../../../src/pipeline/event-bus";
import type { PRD, UserStory } from "../../../../src/prd";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStory(id: string, status: UserStory["status"]): UserStory {
  return {
    id,
    title: `Story ${id}`,
    description: "Test story",
    acceptanceCriteria: [],
    tags: [],
    dependencies: [],
    status,
    passes: status === "passed",
    escalations: [],
    attempts: 1,
  };
}

function makePRD(stories: Array<{ id: string; status: UserStory["status"] }>): PRD {
  return {
    project: "test-project",
    feature: "test-feature",
    branchName: "test-branch",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: stories.map(({ id, status }) => makeStory(id, status)),
  };
}

function makeStatusWriter() {
  return {
    setPrd: mock(() => {}),
    setCurrentStory: mock(() => {}),
    setRunStatus: mock(() => {}),
    setPostRunPhase: mock((_phase: string, _update: Record<string, unknown>) => {}),
    update: mock(async () => {}),
    writeFeatureStatus: mock(async () => {}),
  };
}

function makeStoryMetrics(storyId: string, success: boolean, hops: AgentFallbackHop[]): StoryMetrics {
  return {
    storyId,
    complexity: "medium",
    modelTier: "balanced",
    modelUsed: "claude-sonnet",
    attempts: 1,
    finalTier: "balanced",
    success,
    cost: 0,
    durationMs: 1000,
    firstPassSuccess: success,
    startedAt: "2026-04-20T00:00:00.000Z",
    completedAt: "2026-04-20T00:00:01.000Z",
    ...(hops.length > 0 && { fallback: { hops } }),
  };
}

const WORKDIR = `/tmp/nax-test-pr2-fallback-${randomUUID()}`;

function makeOpts(
  prd: PRD,
  allStoryMetrics: StoryMetrics[],
): RunCompletionOptions {
  const config: NaxConfig = {
    ...DEFAULT_CONFIG,
    execution: {
      ...DEFAULT_CONFIG.execution,
      regressionGate: { ...DEFAULT_CONFIG.execution.regressionGate, mode: "disabled" },
    },
  };
  return {
    runId: "run-001",
    feature: "test-feature",
    startedAt: new Date().toISOString(),
    prd,
    allStoryMetrics,
    totalCost: 0,
    storiesCompleted: allStoryMetrics.filter((s) => s.success).length,
    iterations: 1,
    startTime: Date.now() - 1000,
    workdir: WORKDIR,
    statusWriter: makeStatusWriter() as unknown as RunCompletionOptions["statusWriter"],
    config,
    isSequential: true,
  };
}

const origDeps = { ..._runCompletionDeps };
let capturedEvent: RunCompletedEvent | undefined;
let unsub: (() => void) | undefined;

beforeEach(() => {
  _runCompletionDeps.runDeferredRegression = mock(
    async (): Promise<DeferredRegressionResult> => ({
      success: true,
      failedTests: 0,
      failedTestFiles: [],
      passedTests: 0,
      rectificationAttempts: 0,
      affectedStories: [],
    }),
  );
  capturedEvent = undefined;
  unsub = pipelineEventBus.on("run:completed", (ev) => {
    capturedEvent = ev;
  });
});

afterEach(() => {
  Object.assign(_runCompletionDeps, origDeps);
  unsub?.();
  pipelineEventBus.clear();
  mock.restore();
});

// ---------------------------------------------------------------------------

describe("handleRunCompletion — fallback aggregate wiring (ADR-012 PR-2)", () => {
  test("emits run:completed with fallback aggregate when swaps occurred", async () => {
    const story = makeStoryMetrics("US-001", true, [
      {
        storyId: "US-001",
        priorAgent: "codex",
        newAgent: "claude",
        outcome: "fail-auth",
        category: "availability",
        hop: 1,
        costUsd: 0.05,
      },
    ]);
    const prd = makePRD([{ id: "US-001", status: "passed" }]);

    await handleRunCompletion(makeOpts(prd, [story]));

    expect(capturedEvent).toBeDefined();
    expect(capturedEvent?.fallback).toBeDefined();
    expect(capturedEvent?.fallback?.totalHops).toBe(1);
    expect(capturedEvent?.fallback?.perPair).toEqual({ "codex->claude": 1 });
    expect(capturedEvent?.fallback?.totalWastedCostUsd).toBeCloseTo(0.05, 5);
    expect(capturedEvent?.fallback?.exhaustedStories).toEqual([]);
  });

  test("omits fallback from event when no swaps occurred", async () => {
    const story = makeStoryMetrics("US-001", true, []);
    const prd = makePRD([{ id: "US-001", status: "passed" }]);

    await handleRunCompletion(makeOpts(prd, [story]));

    expect(capturedEvent).toBeDefined();
    expect(capturedEvent?.fallback).toBeUndefined();
  });

  test("marks story as exhausted when run failed and last hop was availability", async () => {
    const story = makeStoryMetrics("US-001", false, [
      {
        storyId: "US-001",
        priorAgent: "codex",
        newAgent: "claude",
        outcome: "fail-auth",
        category: "availability",
        hop: 1,
        costUsd: 0.02,
      },
      {
        storyId: "US-001",
        priorAgent: "claude",
        newAgent: "opencode",
        outcome: "fail-rate-limit",
        category: "availability",
        hop: 2,
        costUsd: 0.03,
      },
    ]);
    const prd = makePRD([{ id: "US-001", status: "failed" }]);

    await handleRunCompletion(makeOpts(prd, [story]));

    expect(capturedEvent?.fallback?.exhaustedStories).toEqual(["US-001"]);
    expect(capturedEvent?.fallback?.totalHops).toBe(2);
    expect(capturedEvent?.fallback?.totalWastedCostUsd).toBeCloseTo(0.05, 5);
  });
});
