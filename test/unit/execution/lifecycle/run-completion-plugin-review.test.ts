/**
 * Tests for deferred plugin review consumption in handleRunCompletion (#1146 G2).
 *
 * Verifies that handleRunCompletion surfaces a failing deferred reviewer always
 * (observational mode) and gates the run when config.review.pluginMode === "gating".
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  _runCompletionDeps,
  handleRunCompletion,
  type RunCompletionOptions,
} from "@/execution";
import type { DeferredReviewResult } from "@/execution/deferred-review";
import type { NaxConfig } from "@/config";
import { makeNaxConfig, makeMockRuntime, makePRD } from "@test/helpers";
import { pipelineEventBus } from "../../../../src/pipeline/event-bus";
import type { DeferredRegressionResult } from "../../../../src/execution/lifecycle/run-regression";

const origDeps = { ..._runCompletionDeps };

afterEach(() => {
  Object.assign(_runCompletionDeps, origDeps);
  pipelineEventBus.clear();
  mock.restore();
});

function makeStatusWriter() {
  const setRunStatus = mock(() => {});
  return {
    setRunStatus,
    setPostRunPhase: mock(() => {}),
    getPostRunStatus: () => ({}),
    writeFeatureStatus: mock(async () => {}),
    setPrd: mock(() => {}),
    setCurrentStory: mock(() => {}),
    update: mock(async () => {}),
  };
}

function makePluginModeConfig(pluginMode: "observational" | "gating"): NaxConfig {
  return makeNaxConfig({
    execution: {
      regressionGate: { mode: "disabled" } as never,
    },
    review: { pluginMode },
  });
}

function makeDeferredReview(anyFailed: boolean): DeferredReviewResult {
  return {
    runStartRef: "abc123",
    changedFiles: ["src/x.ts"],
    reviewerResults: [{ name: "semgrep", passed: !anyFailed, output: anyFailed ? "1 finding" : "ok" }],
    anyFailed,
  };
}

function makeOpts(
  pluginMode: "observational" | "gating",
  deferredReview: DeferredReviewResult | undefined,
  statusWriter: ReturnType<typeof makeStatusWriter>,
): RunCompletionOptions {
  return {
    runId: randomUUID(),
    feature: "f",
    startedAt: new Date().toISOString(),
    prd: makePRD(),
    allStoryMetrics: [],
    totalCost: 0,
    storiesCompleted: 1,
    iterations: 1,
    startTime: Date.now(),
    workdir: "/tmp/x",
    statusWriter: statusWriter as unknown as RunCompletionOptions["statusWriter"],
    config: makePluginModeConfig(pluginMode),
    deferredReview,
    runtime: makeMockRuntime(),
  } as unknown as RunCompletionOptions;
}

describe("handleRunCompletion deferred plugin review (#1146 G2)", () => {
  // Stub out regression so tests exercise only the deferred-review path.
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
  });

  // NB: handleRunCompletion does NOT call setRunStatus for the plugin gate —
  // outcome flows via the returned pluginGateFailed flag (Defect 2 fix).
  test("observational: failing reviewer does NOT set pluginGateFailed", async () => {
    const sw = makeStatusWriter();
    const result = await handleRunCompletion(makeOpts("observational", makeDeferredReview(true), sw));
    expect(result.pluginGateFailed).toBe(false);
  });

  test("gating: failing reviewer sets pluginGateFailed", async () => {
    const sw = makeStatusWriter();
    const result = await handleRunCompletion(makeOpts("gating", makeDeferredReview(true), sw));
    expect(result.pluginGateFailed).toBe(true);
  });

  test("gating: passing reviewer does NOT set pluginGateFailed", async () => {
    const sw = makeStatusWriter();
    const result = await handleRunCompletion(makeOpts("gating", makeDeferredReview(false), sw));
    expect(result.pluginGateFailed).toBe(false);
  });

  test("no deferred review: pluginGateFailed is false", async () => {
    const sw = makeStatusWriter();
    const result = await handleRunCompletion(makeOpts("gating", undefined, sw));
    expect(result.pluginGateFailed).toBe(false);
  });
});
