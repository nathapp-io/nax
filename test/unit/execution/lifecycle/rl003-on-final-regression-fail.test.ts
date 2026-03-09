/**
 * RL-003: on-final-regression-fail hook fires when deferred regression fails
 *
 * Acceptance Criteria Tested:
 * - AC #1: on-final-regression-fail is a registered HookEvent
 * - AC #2: Payload includes failedTests count and affectedStories list
 * - AC #3: Hook triggered correctly in run-completion.ts (fires on failure, not on success)
 *
 * Design:
 * - Uses _runCompletionDeps injection to control runDeferredRegression and fireHook
 * - RunCompletionOptions must accept a hooksConfig for the hook to fire
 *
 * These tests are RED (failing) until RL-003 is implemented.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { NaxConfig } from "../../../../src/config";
import { DEFAULT_CONFIG } from "../../../../src/config/defaults";
import {
  _runCompletionDeps,
  handleRunCompletion,
  type RunCompletionOptions,
} from "../../../../src/execution/lifecycle/run-completion";
import type { DeferredRegressionResult } from "../../../../src/execution/lifecycle/run-regression";
import { HOOK_EVENTS } from "../../../../src/hooks/types";
import type { StoryMetrics } from "../../../../src/metrics";
import type { PRD, UserStory } from "../../../../src/prd/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeStory(id: string, status: UserStory["status"] = "passed"): UserStory {
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

function makePRD(stories: UserStory[]): PRD {
  return {
    project: "test-project",
    feature: "test-feature",
    branchName: "test-branch",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: stories,
  } as unknown as PRD;
}

function makeConfig(regressionMode: "deferred" | "per-story" | "disabled" = "deferred"): NaxConfig {
  return {
    ...DEFAULT_CONFIG,
    execution: {
      ...DEFAULT_CONFIG.execution,
      regressionGate: {
        enabled: true,
        timeoutSeconds: 30,
        acceptOnTimeout: true,
        mode: regressionMode,
        maxRectificationAttempts: 2,
      },
    },
    quality: {
      ...DEFAULT_CONFIG.quality,
      commands: { test: "bun test" },
    },
  };
}

function makeStatusWriter() {
  return {
    setPrd: mock(() => {}),
    setCurrentStory: mock(() => {}),
    setRunStatus: mock(() => {}),
    update: mock(async () => {}),
    writeFeatureStatus: mock(async () => {}),
  };
}

const MOCK_HOOKS_CONFIG = {
  hooks: {
    // @ts-expect-error on-final-regression-fail not yet in HookEvent
    "on-final-regression-fail": {
      command: "echo hook-fired",
      enabled: true,
      timeout: 5000,
    },
  },
};

function makeOpts(
  config: NaxConfig,
  prd: PRD,
  workdir = "/tmp/nax-rl003-test",
): RunCompletionOptions {
  return {
    runId: "run-rl003",
    feature: "test-feature",
    startedAt: new Date().toISOString(),
    prd,
    allStoryMetrics: [] as StoryMetrics[],
    totalCost: 1.0,
    storiesCompleted: 2,
    iterations: 2,
    startTime: Date.now() - 1000,
    workdir,
    statusWriter: makeStatusWriter() as unknown as RunCompletionOptions["statusWriter"],
    config,
    // hooksConfig is required by RL-003 — not yet in RunCompletionOptions
    // FAILS until RunCompletionOptions adds hooksConfig field
    // @ts-ignore hooksConfig not yet in RunCompletionOptions
    hooksConfig: MOCK_HOOKS_CONFIG,
  };
}

// ---------------------------------------------------------------------------
// Deps injection setup
// ---------------------------------------------------------------------------

const origRunCompletionDeps = { ..._runCompletionDeps };

let mockRunDeferredRegression: ReturnType<typeof mock>;
let mockFireHook: ReturnType<typeof mock>;

beforeEach(() => {
  mockRunDeferredRegression = mock(async (): Promise<DeferredRegressionResult> => ({
    success: true,
    failedTests: 0,
    passedTests: 10,
    rectificationAttempts: 0,
    affectedStories: [],
  }));
  _runCompletionDeps.runDeferredRegression =
    mockRunDeferredRegression as typeof _runCompletionDeps.runDeferredRegression;

  // fireHook injected via _runCompletionDeps — FAILS until RL-003 adds this dep
  mockFireHook = mock(async () => {});
  // @ts-expect-error fireHook not yet in _runCompletionDeps
  _runCompletionDeps.fireHook = mockFireHook;
});

afterEach(() => {
  Object.assign(_runCompletionDeps, origRunCompletionDeps);
  mock.restore();
});

// ---------------------------------------------------------------------------
// AC #1: on-final-regression-fail type registration
// ---------------------------------------------------------------------------

describe("RL-003 AC#1: on-final-regression-fail is a registered HookEvent", () => {
  test("on-final-regression-fail is in the HOOK_EVENTS registry", () => {
    // FAILS until "on-final-regression-fail" is added to HOOK_EVENTS in types.ts
    // @ts-ignore - on-final-regression-fail intentionally not yet in HookEvent
    expect(HOOK_EVENTS).toContain("on-final-regression-fail");
  });

  test("HOOK_EVENTS contains on-final-regression-fail alongside other events", () => {
    const events = [...HOOK_EVENTS];
    expect(events).toContain("on-start");
    expect(events).toContain("on-complete");
    expect(events).toContain("on-error");
    // FAILS until "on-final-regression-fail" is added to HOOK_EVENTS
    // @ts-ignore - on-final-regression-fail intentionally not yet in HookEvent
    expect(events).toContain("on-final-regression-fail");
  });
});

// ---------------------------------------------------------------------------
// AC #3: Hook triggered correctly in run-completion.ts
// ---------------------------------------------------------------------------

describe("RL-003 AC#3: on-final-regression-fail fires on regression failure", () => {
  test("fireHook is called with on-final-regression-fail when regression fails", async () => {
    // Configure regression to fail
    mockRunDeferredRegression = mock(async (): Promise<DeferredRegressionResult> => ({
      success: false,
      failedTests: 3,
      passedTests: 7,
      rectificationAttempts: 2,
      affectedStories: ["US-001", "US-002"],
    }));
    _runCompletionDeps.runDeferredRegression =
      mockRunDeferredRegression as typeof _runCompletionDeps.runDeferredRegression;

    const prd = makePRD([makeStory("US-001", "passed"), makeStory("US-002", "passed")]);
    const config = makeConfig("deferred");

    try {
      await handleRunCompletion(makeOpts(config, prd));
    } catch {
      // Ignore disk write errors in test env
    }

    // FAILS until RL-003 adds fireHook call in run-completion.ts
    expect(mockFireHook).toHaveBeenCalled();
    const calls = mockFireHook.mock.calls as unknown[][];
    const eventArg = calls.find((args) => args[1] === "on-final-regression-fail");
    expect(eventArg).toBeDefined();
  });

  test("fireHook is NOT called when regression succeeds", async () => {
    // Regression succeeds (default in beforeEach)
    const prd = makePRD([makeStory("US-001", "passed")]);
    const config = makeConfig("deferred");

    try {
      await handleRunCompletion(makeOpts(config, prd));
    } catch {
      // Ignore disk write errors
    }

    // When regression succeeds, on-final-regression-fail must NOT fire
    const calls = mockFireHook.mock.calls as unknown[][];
    const failHookCalls = calls.filter((args) => args[1] === "on-final-regression-fail");
    expect(failHookCalls).toHaveLength(0);
  });

  test("fireHook is NOT called when regression mode is disabled (regression never runs)", async () => {
    const prd = makePRD([makeStory("US-001", "passed")]);
    const config = makeConfig("disabled");

    try {
      await handleRunCompletion(makeOpts(config, prd));
    } catch {
      // Ignore disk write errors
    }

    // Regression gate is disabled — hook must not fire
    const calls = mockFireHook.mock.calls as unknown[][];
    const failHookCalls = calls.filter((args) => args[1] === "on-final-regression-fail");
    expect(failHookCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC #2: Payload includes failedTests count and affectedStories list
// ---------------------------------------------------------------------------

describe("RL-003 AC#2: hook payload includes failedTests and affectedStories", () => {
  test("hook context includes failedTests count from regression result", async () => {
    mockRunDeferredRegression = mock(async (): Promise<DeferredRegressionResult> => ({
      success: false,
      failedTests: 5,
      passedTests: 3,
      rectificationAttempts: 2,
      affectedStories: ["US-001"],
    }));
    _runCompletionDeps.runDeferredRegression =
      mockRunDeferredRegression as typeof _runCompletionDeps.runDeferredRegression;

    const prd = makePRD([makeStory("US-001", "passed")]);
    const config = makeConfig("deferred");

    try {
      await handleRunCompletion(makeOpts(config, prd));
    } catch {
      // Ignore disk write errors
    }

    // FAILS until RL-003 passes failedTests in hook context
    const calls = mockFireHook.mock.calls as unknown[][];
    const failHookCall = calls.find((args) => args[1] === "on-final-regression-fail");
    expect(failHookCall).toBeDefined();

    // Third argument is the hook context
    const ctx = failHookCall?.[2] as Record<string, unknown>;
    expect(ctx).toBeDefined();
    expect(ctx?.failedTests).toBe(5);
  });

  test("hook context includes affectedStories list from regression result", async () => {
    mockRunDeferredRegression = mock(async (): Promise<DeferredRegressionResult> => ({
      success: false,
      failedTests: 2,
      passedTests: 8,
      rectificationAttempts: 1,
      affectedStories: ["US-002", "US-003"],
    }));
    _runCompletionDeps.runDeferredRegression =
      mockRunDeferredRegression as typeof _runCompletionDeps.runDeferredRegression;

    const prd = makePRD([makeStory("US-002", "passed"), makeStory("US-003", "passed")]);
    const config = makeConfig("deferred");

    try {
      await handleRunCompletion(makeOpts(config, prd));
    } catch {
      // Ignore disk write errors
    }

    // FAILS until RL-003 passes affectedStories in hook context
    const calls = mockFireHook.mock.calls as unknown[][];
    const failHookCall = calls.find((args) => args[1] === "on-final-regression-fail");
    expect(failHookCall).toBeDefined();

    const ctx = failHookCall?.[2] as Record<string, unknown>;
    expect(ctx).toBeDefined();
    expect(ctx?.affectedStories).toEqual(["US-002", "US-003"]);
  });

  test("hook context includes feature name from run options", async () => {
    mockRunDeferredRegression = mock(async (): Promise<DeferredRegressionResult> => ({
      success: false,
      failedTests: 1,
      passedTests: 4,
      rectificationAttempts: 0,
      affectedStories: ["US-001"],
    }));
    _runCompletionDeps.runDeferredRegression =
      mockRunDeferredRegression as typeof _runCompletionDeps.runDeferredRegression;

    const prd = makePRD([makeStory("US-001", "passed")]);
    const config = makeConfig("deferred");
    const opts = makeOpts(config, prd);

    try {
      await handleRunCompletion(opts);
    } catch {
      // Ignore disk write errors
    }

    // FAILS until RL-003 populates hook context
    const calls = mockFireHook.mock.calls as unknown[][];
    const failHookCall = calls.find((args) => args[1] === "on-final-regression-fail");
    expect(failHookCall).toBeDefined();

    const ctx = failHookCall?.[2] as Record<string, unknown>;
    expect(ctx?.feature).toBe("test-feature");
  });

  test("hook context status is 'failed' when regression fails", async () => {
    mockRunDeferredRegression = mock(async (): Promise<DeferredRegressionResult> => ({
      success: false,
      failedTests: 4,
      passedTests: 6,
      rectificationAttempts: 2,
      affectedStories: ["US-001", "US-003"],
    }));
    _runCompletionDeps.runDeferredRegression =
      mockRunDeferredRegression as typeof _runCompletionDeps.runDeferredRegression;

    const prd = makePRD([makeStory("US-001", "passed"), makeStory("US-003", "passed")]);
    const config = makeConfig("deferred");

    try {
      await handleRunCompletion(makeOpts(config, prd));
    } catch {
      // Ignore disk write errors
    }

    const calls = mockFireHook.mock.calls as unknown[][];
    const failHookCall = calls.find((args) => args[1] === "on-final-regression-fail");
    expect(failHookCall).toBeDefined();

    // FAILS until RL-003 sets status: "failed" in hook context
    const ctx = failHookCall?.[2] as Record<string, unknown>;
    expect(ctx?.status).toBe("failed");
  });
});
