/**
 * Tests for setPostRunPhase calls in handleRunCompletion (US-002)
 *
 * Verifies that handleRunCompletion instruments the regression phase with
 * setPostRunPhase() at each entry/exit boundary:
 *
 * AC4: calls setPostRunPhase("regression", { status: "running" }) before runDeferredRegression()
 * AC5: calls setPostRunPhase("regression", { status: "passed", lastRunAt }) on success
 * AC6: calls setPostRunPhase("regression", { status: "failed", affectedStories, lastRunAt }) on failure
 * AC7: deferred regression is not smart-skipped when stories previously passed full-suite gates
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { NaxConfig } from "@/config";
import {
  type DeferredRegressionResult,
  type RunCompletionOptions,
  _runCompletionDeps,
  handleRunCompletion,
} from "@/execution";
import type { StoryMetrics } from "@/metrics";
import { pipelineEventBus } from "@/pipeline/event-bus";
import type { PRD, UserStory } from "@/prd";
import { makeMockRuntime, makeNaxConfig } from "@test/helpers";

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

function makeConfig(
  regressionMode: "deferred" | "per-story" | "disabled" = "deferred",
  testCommand = "bun test",
): NaxConfig {
  return makeNaxConfig({
    execution: {
      regressionGate: {
        enabled: true,
        timeoutSeconds: 30,
        acceptOnTimeout: true,
        mode: regressionMode,
      },
    },
    quality: {
      commands: {
        test: testCommand,
      },
    },
  });
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

function makeStoryMetrics(storyId: string, fullSuiteGatePassed: boolean | undefined): StoryMetrics {
  return {
    storyId,
    complexity: "simple",
    modelTier: "standard",
    modelUsed: "claude-sonnet-4-5",
    attempts: 1,
    finalTier: "standard",
    success: true,
    cost: 0.01,
    durationMs: 1000,
    firstPassSuccess: true,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    fullSuiteGatePassed,
  };
}

const WORKDIR = `/tmp/nax-test-postrun-regression-${randomUUID()}`;

function makeOpts(
  config: NaxConfig,
  prd: PRD,
  overrides?: Partial<RunCompletionOptions> & { statusWriter?: ReturnType<typeof makeStatusWriter> },
): RunCompletionOptions {
  const { statusWriter, ...rest } = overrides ?? {};
  return {
    runId: "run-001",
    feature: "test-feature",
    startedAt: new Date().toISOString(),
    prd,
    allStoryMetrics: [] as StoryMetrics[],
    totalCost: 0,
    storiesCompleted: 1,
    iterations: 1,
    startTime: Date.now() - 1000,
    workdir: WORKDIR,
    statusWriter: (statusWriter ?? makeStatusWriter()) as unknown as RunCompletionOptions["statusWriter"],
    config,
    runtime: makeMockRuntime(),
    ...rest,
  };
}

const origDeps = { ..._runCompletionDeps };

beforeEach(() => {
  // Default mock: regression succeeds
  _runCompletionDeps.runDeferredRegression = mock(
    async (): Promise<DeferredRegressionResult> => ({
      success: true,
      failedTests: 0,
      failedTestFiles: [],
      passedTests: 10,
      rectificationAttempts: 0,
      affectedStories: [],
    }),
  );
});

afterEach(() => {
  Object.assign(_runCompletionDeps, origDeps);
  pipelineEventBus.clear();
  mock.restore();
});

// ---------------------------------------------------------------------------
// AC4: setPostRunPhase("regression", { status: "running" }) before regression
// ---------------------------------------------------------------------------

describe("handleRunCompletion - AC4: sets regression running before runDeferredRegression()", () => {
  test("calls setPostRunPhase('regression', { status: 'running' }) before runDeferredRegression()", async () => {
    const callOrder: string[] = [];

    const statusWriter = makeStatusWriter();
    statusWriter.setPostRunPhase = mock((phase: string, update: { status: string }) => {
      if (phase === "regression") {
        callOrder.push(`setPostRunPhase-regression-${update.status}`);
      }
    });

    _runCompletionDeps.runDeferredRegression = mock(async (): Promise<DeferredRegressionResult> => {
      callOrder.push("runDeferredRegression");
      return {
        success: true,
        failedTests: 0,
        failedTestFiles: [],
        passedTests: 5,
        rectificationAttempts: 0,
        affectedStories: [],
      };
    });

    const prd = makePRD([{ id: "US-001", status: "passed" }]);
    const config = makeConfig("deferred", "bun test");

    await handleRunCompletion(makeOpts(config, prd, { statusWriter }));

    const runningIdx = callOrder.indexOf("setPostRunPhase-regression-running");
    const regressionIdx = callOrder.indexOf("runDeferredRegression");

    expect(runningIdx).toBeGreaterThanOrEqual(0);
    expect(runningIdx).toBeLessThan(regressionIdx);
  });

  test("does NOT call setPostRunPhase for regression when mode is disabled", async () => {
    const statusWriter = makeStatusWriter();
    const prd = makePRD([{ id: "US-001", status: "passed" }]);
    const config = makeConfig("disabled", "bun test");

    await handleRunCompletion(makeOpts(config, prd, { statusWriter }));

    const regressionCalls = statusWriter.setPostRunPhase.mock.calls.filter((c: unknown[]) => c[0] === "regression");
    expect(regressionCalls.length).toBe(0);
  });

  test("DOES call setPostRunPhase + runDeferredRegression when mode is per-story (superset of deferred)", async () => {
    const statusWriter = makeStatusWriter();
    const prd = makePRD([{ id: "US-001", status: "passed" }]);
    const config = makeConfig("per-story", "bun test");

    await handleRunCompletion(makeOpts(config, prd, { statusWriter }));

    expect(_runCompletionDeps.runDeferredRegression).toHaveBeenCalled();
    const regressionCalls = statusWriter.setPostRunPhase.mock.calls.filter((c: unknown[]) => c[0] === "regression");
    expect(regressionCalls.length).toBeGreaterThan(0);
  });

  test("does NOT call setPostRunPhase for regression when no test command configured", async () => {
    const statusWriter = makeStatusWriter();
    const prd = makePRD([{ id: "US-001", status: "passed" }]);
    const config = makeNaxConfig({
      execution: {
        regressionGate: {
          enabled: true,
          timeoutSeconds: 30,
          acceptOnTimeout: true,
          mode: "deferred",
        },
      },
      quality: {
        commands: {},
      },
    });

    await handleRunCompletion(makeOpts(config, prd, { statusWriter }));

    const regressionCalls = statusWriter.setPostRunPhase.mock.calls.filter((c: unknown[]) => c[0] === "regression");
    expect(regressionCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC5: setPostRunPhase("regression", { status: "passed", lastRunAt }) on success
// ---------------------------------------------------------------------------

describe("handleRunCompletion - AC5: sets regression passed on success", () => {
  test("calls setPostRunPhase('regression', { status: 'passed', lastRunAt }) when regression succeeds", async () => {
    const regressionCalls: Array<Record<string, unknown>> = [];

    const statusWriter = makeStatusWriter();
    statusWriter.setPostRunPhase = mock((phase: string, update: Record<string, unknown>) => {
      if (phase === "regression") {
        regressionCalls.push(update);
      }
    });

    _runCompletionDeps.runDeferredRegression = mock(
      async (): Promise<DeferredRegressionResult> => ({
        success: true,
        failedTests: 0,
        failedTestFiles: [],
        passedTests: 10,
        rectificationAttempts: 0,
        affectedStories: [],
      }),
    );

    const prd = makePRD([{ id: "US-001", status: "passed" }]);
    const config = makeConfig("deferred", "bun test");

    await handleRunCompletion(makeOpts(config, prd, { statusWriter }));

    const passedCall = regressionCalls.find((u) => u.status === "passed");
    expect(passedCall).toBeDefined();
    expect(typeof passedCall?.lastRunAt).toBe("string");
    // Must be ISO 8601
    expect(new Date(passedCall?.lastRunAt as string).toISOString()).toBe(passedCall?.lastRunAt);
  });

  test("passed call does not include skipped:true when regression actually ran", async () => {
    const regressionCalls: Array<Record<string, unknown>> = [];

    const statusWriter = makeStatusWriter();
    statusWriter.setPostRunPhase = mock((phase: string, update: Record<string, unknown>) => {
      if (phase === "regression") {
        regressionCalls.push(update);
      }
    });

    const prd = makePRD([{ id: "US-001", status: "passed" }]);
    const config = makeConfig("deferred", "bun test");

    await handleRunCompletion(makeOpts(config, prd, { statusWriter }));

    const passedCall = regressionCalls.find((u) => u.status === "passed");
    expect(passedCall?.skipped).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC6: setPostRunPhase("regression", { status: "failed", affectedStories, lastRunAt }) on failure
// ---------------------------------------------------------------------------

describe("handleRunCompletion - AC6: sets regression failed on failure", () => {
  test("calls setPostRunPhase('regression', { status: 'failed', affectedStories, lastRunAt }) when regression fails", async () => {
    const regressionCalls: Array<Record<string, unknown>> = [];

    const statusWriter = makeStatusWriter();
    statusWriter.setPostRunPhase = mock((phase: string, update: Record<string, unknown>) => {
      if (phase === "regression") {
        regressionCalls.push(update);
      }
    });

    _runCompletionDeps.runDeferredRegression = mock(
      async (): Promise<DeferredRegressionResult> => ({
        success: false,
        failedTests: 3,
        failedTestFiles: [],
        passedTests: 7,
        rectificationAttempts: 2,
        affectedStories: ["US-001", "US-002"],
      }),
    );

    const prd = makePRD([
      { id: "US-001", status: "passed" },
      { id: "US-002", status: "passed" },
    ]);
    const config = makeConfig("deferred", "bun test");

    await handleRunCompletion(makeOpts(config, prd, { statusWriter }));

    const failedCall = regressionCalls.find((u) => u.status === "failed");
    expect(failedCall).toBeDefined();
    expect(typeof failedCall?.lastRunAt).toBe("string");
    expect(new Date(failedCall?.lastRunAt as string).toISOString()).toBe(failedCall?.lastRunAt);
  });

  test("failed call includes affectedStories from regressionResult", async () => {
    const regressionCalls: Array<Record<string, unknown>> = [];

    const statusWriter = makeStatusWriter();
    statusWriter.setPostRunPhase = mock((phase: string, update: Record<string, unknown>) => {
      if (phase === "regression") {
        regressionCalls.push(update);
      }
    });

    _runCompletionDeps.runDeferredRegression = mock(
      async (): Promise<DeferredRegressionResult> => ({
        success: false,
        failedTests: 2,
        failedTestFiles: [],
        passedTests: 5,
        rectificationAttempts: 1,
        affectedStories: ["US-003", "US-004"],
      }),
    );

    const prd = makePRD([
      { id: "US-003", status: "passed" },
      { id: "US-004", status: "passed" },
    ]);
    const config = makeConfig("deferred", "bun test");

    await handleRunCompletion(makeOpts(config, prd, { statusWriter }));

    const failedCall = regressionCalls.find((u) => u.status === "failed");
    expect(failedCall?.affectedStories).toEqual(["US-003", "US-004"]);
  });

  test("failed call includes failedTests file paths from regressionResult.failedTestFiles", async () => {
    const regressionCalls: Array<Record<string, unknown>> = [];

    const statusWriter = makeStatusWriter();
    statusWriter.setPostRunPhase = mock((phase: string, update: Record<string, unknown>) => {
      if (phase === "regression") {
        regressionCalls.push(update);
      }
    });

    _runCompletionDeps.runDeferredRegression = mock(
      async (): Promise<DeferredRegressionResult> => ({
        success: false,
        failedTests: 2,
        failedTestFiles: ["test/unit/foo.test.ts", "test/unit/bar.test.ts"],
        passedTests: 5,
        rectificationAttempts: 1,
        affectedStories: ["US-005"],
      }),
    );

    const prd = makePRD([{ id: "US-005", status: "passed" }]);
    const config = makeConfig("deferred", "bun test");

    await handleRunCompletion(makeOpts(config, prd, { statusWriter }));

    const failedCall = regressionCalls.find((u) => u.status === "failed");
    expect(failedCall?.failedTests).toEqual(["test/unit/foo.test.ts", "test/unit/bar.test.ts"]);
  });

  test("running is called before failed when regression fails", async () => {
    const callOrder: string[] = [];

    const statusWriter = makeStatusWriter();
    statusWriter.setPostRunPhase = mock((phase: string, update: { status: string }) => {
      if (phase === "regression") {
        callOrder.push(`setPostRunPhase-regression-${update.status}`);
      }
    });

    _runCompletionDeps.runDeferredRegression = mock(
      async (): Promise<DeferredRegressionResult> => ({
        success: false,
        failedTests: 1,
        failedTestFiles: [],
        passedTests: 5,
        rectificationAttempts: 0,
        affectedStories: ["US-001"],
      }),
    );

    const prd = makePRD([{ id: "US-001", status: "passed" }]);
    const config = makeConfig("deferred", "bun test");

    await handleRunCompletion(makeOpts(config, prd, { statusWriter }));

    expect(callOrder.indexOf("setPostRunPhase-regression-running")).toBeLessThan(
      callOrder.indexOf("setPostRunPhase-regression-failed"),
    );
  });

  test("resets story.passes to false for affected stories, not just status (issue #1292)", async () => {
    const statusWriter = makeStatusWriter();

    _runCompletionDeps.runDeferredRegression = mock(
      async (): Promise<DeferredRegressionResult> => ({
        success: false,
        failedTests: 1,
        failedTestFiles: [],
        passedTests: 5,
        rectificationAttempts: 0,
        affectedStories: ["US-001"],
      }),
    );

    const prd = makePRD([
      { id: "US-001", status: "passed" },
      { id: "US-002", status: "passed" },
    ]);
    const config = makeConfig("deferred", "bun test");

    await handleRunCompletion(makeOpts(config, prd, { statusWriter }));

    const affectedStory = prd.userStories.find((s) => s.id === "US-001");
    expect(affectedStory?.status).toBe("regression-failed");
    expect(affectedStory?.passes).toBe(false);

    const unaffectedStory = prd.userStories.find((s) => s.id === "US-002");
    expect(unaffectedStory?.passes).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC7: deferred regression still runs after acceptance/hardening changes
// ---------------------------------------------------------------------------

describe("handleRunCompletion - AC7: deferred regression is not smart-skipped", () => {
  test("still calls runDeferredRegression when all stories report fullSuiteGatePassed=true", async () => {
    const regressionCalls: Array<Record<string, unknown>> = [];

    const statusWriter = makeStatusWriter();
    statusWriter.setPostRunPhase = mock((phase: string, update: Record<string, unknown>) => {
      if (phase === "regression") {
        regressionCalls.push(update);
      }
    });

    const metrics = [makeStoryMetrics("US-001", true), makeStoryMetrics("US-002", true)];
    const prd = makePRD([
      { id: "US-001", status: "passed" },
      { id: "US-002", status: "passed" },
    ]);
    const config = makeConfig("deferred", "bun test");

    await handleRunCompletion(
      makeOpts(config, prd, {
        statusWriter,
        allStoryMetrics: metrics,
        isSequential: true,
      }),
    );

    expect(_runCompletionDeps.runDeferredRegression).toHaveBeenCalledTimes(1);
    expect(regressionCalls.some((u) => u.status === "running")).toBe(true);
    expect(regressionCalls.some((u) => u.skipped === true)).toBe(false);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // AC7: run-completion passes runtime: options.runtime (not agentManager) to runDeferredRegression
  // ─────────────────────────────────────────────────────────────────────────────

  test("AC7: passes runtime to runDeferredRegression and does not pass agentManager", async () => {
    let capturedArgs: Record<string, unknown> | undefined;
    _runCompletionDeps.runDeferredRegression = mock(async (opts) => {
      capturedArgs = opts as unknown as Record<string, unknown>;
      return {
        success: true,
        failedTests: 0,
        failedTestFiles: [],
        passedTests: 0,
        rectificationAttempts: 0,
        affectedStories: [],
      };
    });

    const mockRuntime = makeMockRuntime();
    const prd = makePRD([{ id: "US-001", status: "passed" }]);
    const config = makeConfig("deferred", "bun test");

    await handleRunCompletion(makeOpts(config, prd, { runtime: mockRuntime }));

    // AC7: runtime is passed through, agentManager is not explicitly passed
    expect(capturedArgs?.runtime).toBe(mockRuntime);
    expect(capturedArgs?.agentManager).toBeUndefined();
  });

  test("setPostRunPhase tracks running then terminal status when all stories previously passed full-suite gates", async () => {
    const setPostRunPhaseCalls: Array<[string, Record<string, unknown>]> = [];

    const statusWriter = makeStatusWriter();
    statusWriter.setPostRunPhase = mock((phase: string, update: Record<string, unknown>) => {
      setPostRunPhaseCalls.push([phase, update]);
    });

    const metrics = [makeStoryMetrics("US-001", true)];
    const prd = makePRD([{ id: "US-001", status: "passed" }]);
    const config = makeConfig("deferred", "bun test");

    await handleRunCompletion(
      makeOpts(config, prd, {
        statusWriter,
        allStoryMetrics: metrics,
        isSequential: true,
      }),
    );

    const regressionCalls = setPostRunPhaseCalls.filter(([p]) => p === "regression");
    expect(regressionCalls.length).toBeGreaterThan(0);
    expect(_runCompletionDeps.runDeferredRegression).toHaveBeenCalledTimes(1);
  });

  test("records running before passed instead of emitting a skipped status", async () => {
    const callOrder: string[] = [];

    const statusWriter = makeStatusWriter();
    statusWriter.setPostRunPhase = mock((phase: string, update: { status: string; skipped?: boolean }) => {
      if (phase === "regression") {
        callOrder.push(update.skipped ? `skipped-${update.status}` : update.status);
      }
    });

    const metrics = [makeStoryMetrics("US-001", true)];
    const prd = makePRD([{ id: "US-001", status: "passed" }]);
    const config = makeConfig("deferred", "bun test");

    await handleRunCompletion(
      makeOpts(config, prd, {
        statusWriter,
        allStoryMetrics: metrics,
        isSequential: true,
      }),
    );

    expect(callOrder.indexOf("running")).toBeGreaterThanOrEqual(0);
    expect(callOrder.indexOf("passed")).toBeGreaterThan(callOrder.indexOf("running"));
    expect(callOrder).not.toContain("skipped-passed");
  });
});
