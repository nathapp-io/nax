/**
 * Tests for regression-gate storyMetrics back-fill + merge behavior in handleRunCompletion.
 *
 * Two code paths live in src/execution/lifecycle/run-completion.ts:
 *   1. Back-fill: a story has no entry in allStoryMetrics (resume-run / prior batch) → inject
 *      a synthetic "rectification" entry using per-story cost, duration, and outcome.
 *   2. Merge:    a story already has an entry (normal execution loop + regression-gate
 *      rectification in the same run) → fold the regression cost + duration into the existing
 *      entry, mark firstPassSuccess:false, and preserve the normal-loop success unless the
 *      regression attempt failed.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { NaxConfig } from "../../../../src/config";
import {
  type RunCompletionOptions,
  _runCompletionDeps,
  handleRunCompletion,
} from "../../../../src/execution/lifecycle/run-completion";
import type { DeferredRegressionResult } from "../../../../src/execution/lifecycle/run-regression";
import type { StoryMetrics } from "../../../../src/metrics";
import { pipelineEventBus } from "../../../../src/pipeline/event-bus";
import type { PRD } from "../../../../src/prd";
import { makeNaxConfig, makePRD as makePRDHelper, makeStory } from "../../../helpers";

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

const REGRESSION_CONFIG: NaxConfig = makeNaxConfig({
  execution: {
    regressionGate: {
      enabled: true,
      timeoutSeconds: 30,
      acceptOnTimeout: true,
      mode: "deferred",
      maxRectificationAttempts: 2,
    },
  },
  quality: {
    commands: { test: "bun test" },
  },
});

function makeStatusWriter() {
  return {
    setPrd: mock(() => {}),
    setCurrentStory: mock(() => {}),
    setRunStatus: mock(() => {}),
    setPostRunPhase: mock(() => {}),
    update: mock(async () => {}),
    writeFeatureStatus: mock(async () => {}),
  };
}

function makeStoryMetrics(overrides: Partial<StoryMetrics>): StoryMetrics {
  return {
    storyId: "US-001",
    complexity: "simple",
    modelTier: "balanced",
    modelUsed: "claude-sonnet-4-5",
    attempts: 1,
    finalTier: "balanced",
    success: true,
    cost: 0.1,
    durationMs: 1000,
    firstPassSuccess: true,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    fullSuiteGatePassed: undefined,
    ...overrides,
  };
}

const WORKDIR = `/tmp/nax-test-backfill-${randomUUID()}`;

function makeOpts(config: NaxConfig, prd: PRD, metrics: StoryMetrics[]): RunCompletionOptions {
  return {
    runId: "run-001",
    feature: "test-feature",
    startedAt: new Date().toISOString(),
    prd,
    allStoryMetrics: metrics,
    totalCost: 0,
    storiesCompleted: metrics.length,
    iterations: 1,
    startTime: Date.now() - 1000,
    workdir: WORKDIR,
    statusWriter: makeStatusWriter() as unknown as RunCompletionOptions["statusWriter"],
    config,
  };
}

const origDeps = { ..._runCompletionDeps };

afterEach(() => {
  Object.assign(_runCompletionDeps, origDeps);
  pipelineEventBus.clear();
  mock.restore();
});

function mockRegression(regressionResult: DeferredRegressionResult) {
  _runCompletionDeps.runDeferredRegression = mock(async (): Promise<DeferredRegressionResult> => regressionResult);
}

// ---------------------------------------------------------------------------
// Back-fill (story not already in allStoryMetrics)
// ---------------------------------------------------------------------------

describe("handleRunCompletion — back-fill for stories missing from allStoryMetrics", () => {
  test("injects a synthetic rectification entry with real per-story duration and outcome", async () => {
    const prd = makePRD(["US-001"]);
    const metrics: StoryMetrics[] = []; // no existing entry

    mockRegression({
      success: false, // overall regression still failing
      failedTests: 2,
      failedTestFiles: ["test/foo.test.ts"],
      passedTests: 8,
      rectificationAttempts: 1,
      affectedStories: ["US-001"],
      storyCosts: { "US-001": 0.42 },
      storyDurations: { "US-001": 314 },
      storyOutcomes: { "US-001": true }, // story itself succeeded, but suite still failing
    });

    await handleRunCompletion(makeOpts(REGRESSION_CONFIG, prd, metrics));

    expect(metrics).toHaveLength(1);
    const entry = metrics[0];
    expect(entry.storyId).toBe("US-001");
    expect(entry.source).toBe("rectification");
    expect(entry.cost).toBeCloseTo(0.42);
    expect(entry.durationMs).toBe(314);
    expect(entry.rectificationCost).toBeCloseTo(0.42);
    expect(entry.firstPassSuccess).toBe(false);
    // Uses per-story outcome, NOT the overall regression success
    expect(entry.success).toBe(true);
  });

  test("falls back to overall regression success when per-story outcome is absent", async () => {
    const prd = makePRD(["US-001"]);
    const metrics: StoryMetrics[] = [];

    mockRegression({
      success: false,
      failedTests: 1,
      failedTestFiles: [],
      passedTests: 0,
      rectificationAttempts: 1,
      affectedStories: ["US-001"],
      storyCosts: { "US-001": 0.1 },
      // storyOutcomes intentionally omitted (older mock shape)
    });

    await handleRunCompletion(makeOpts(REGRESSION_CONFIG, prd, metrics));

    expect(metrics[0].success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Merge (story already exists in allStoryMetrics)
// ---------------------------------------------------------------------------

describe("handleRunCompletion — merge regression cost into existing storyMetrics", () => {
  test("folds rectification cost and duration into the normal-loop entry", async () => {
    const prd = makePRD(["US-001"]);
    const existing = makeStoryMetrics({
      storyId: "US-001",
      cost: 0.5,
      durationMs: 2000,
      rectificationCost: 0.05,
      firstPassSuccess: true,
      success: true,
    });
    const metrics: StoryMetrics[] = [existing];

    mockRegression({
      success: true,
      failedTests: 0,
      failedTestFiles: [],
      passedTests: 5,
      rectificationAttempts: 1,
      affectedStories: ["US-001"],
      storyCosts: { "US-001": 0.3 },
      storyDurations: { "US-001": 500 },
      storyOutcomes: { "US-001": true },
    });

    await handleRunCompletion(makeOpts(REGRESSION_CONFIG, prd, metrics));

    expect(metrics).toHaveLength(1); // still one entry
    const merged = metrics[0];
    expect(merged.cost).toBeCloseTo(0.8); // 0.5 + 0.3
    expect(merged.durationMs).toBe(2500); // 2000 + 500
    expect(merged.rectificationCost).toBeCloseTo(0.35); // 0.05 + 0.3
    // A story that went through regression-gate rectification is NOT a clean first pass
    expect(merged.firstPassSuccess).toBe(false);
    // Rectification succeeded — overall success preserved
    expect(merged.success).toBe(true);
  });

  test("marks existing entry success=false when regression-gate rectification failed", async () => {
    const prd = makePRD(["US-001"]);
    const existing = makeStoryMetrics({ storyId: "US-001", success: true });
    const metrics: StoryMetrics[] = [existing];

    mockRegression({
      success: false,
      failedTests: 1,
      failedTestFiles: [],
      passedTests: 0,
      rectificationAttempts: 2,
      affectedStories: ["US-001"],
      storyCosts: { "US-001": 0.2 },
      storyDurations: { "US-001": 100 },
      storyOutcomes: { "US-001": false },
    });

    await handleRunCompletion(makeOpts(REGRESSION_CONFIG, prd, metrics));

    expect(metrics[0].success).toBe(false);
    expect(metrics[0].firstPassSuccess).toBe(false);
  });

  test("initializes rectificationCost from 0 when the existing entry has no prior rectification", async () => {
    const prd = makePRD(["US-001"]);
    const existing = makeStoryMetrics({ storyId: "US-001", rectificationCost: undefined });
    const metrics: StoryMetrics[] = [existing];

    mockRegression({
      success: true,
      failedTests: 0,
      failedTestFiles: [],
      passedTests: 1,
      rectificationAttempts: 1,
      affectedStories: ["US-001"],
      storyCosts: { "US-001": 0.25 },
      storyDurations: { "US-001": 200 },
      storyOutcomes: { "US-001": true },
    });

    await handleRunCompletion(makeOpts(REGRESSION_CONFIG, prd, metrics));

    expect(metrics[0].rectificationCost).toBeCloseTo(0.25);
  });
});
