// RE-ARCH: keep
/**
 * run-completion.ts — Deferred regression gate invocation (US-003)
 *
 * Tests that handleRunCompletion:
 * - Calls runDeferredRegression when mode is 'deferred' AND test command exists
 * - Does NOT call runDeferredRegression when mode is 'per-story'
 * - Does NOT call runDeferredRegression when mode is 'disabled'
 * - Does NOT call runDeferredRegression when no test command is configured
 * - Returns correct RunCompletionResult shape regardless of regression mode
 *
 * Uses _runCompletionDeps injection to avoid spawning actual test processes.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { NaxConfig } from "../../../../src/config";
import { DEFAULT_CONFIG } from "../../../../src/config/defaults";
import type { PRD, UserStory } from "../../../../src/prd";
import type { StoryMetrics } from "../../../../src/metrics";
import {
  handleRunCompletion,
  _runCompletionDeps,
  type RunCompletionOptions,
} from "../../../../src/execution/lifecycle/run-completion";
import type { DeferredRegressionResult } from "../../../../src/execution/lifecycle/run-regression";

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

function makeConfig(
  regressionMode?: "deferred" | "per-story" | "disabled",
  testCommand?: string,
): NaxConfig {
  return {
    ...DEFAULT_CONFIG,
    execution: {
      ...DEFAULT_CONFIG.execution,
      regressionGate: {
        enabled: true,
        timeoutSeconds: 30,
        acceptOnTimeout: true,
        mode: regressionMode ?? "deferred",
        maxRectificationAttempts: 2,
      },
    },
    quality: {
      ...DEFAULT_CONFIG.quality,
      commands: testCommand !== undefined ? { test: testCommand } : {},
    },
  };
}

const MOCK_REGRESSION_SUCCESS: DeferredRegressionResult = {
  success: true,
  failedTests: 0,
  passedTests: 5,
  rectificationAttempts: 0,
  affectedStories: [],
};

// ---------------------------------------------------------------------------
// Status writer mock
// ---------------------------------------------------------------------------

function makeStatusWriter() {
  return {
    setPrd: mock(() => {}),
    setCurrentStory: mock(() => {}),
    setRunStatus: mock(() => {}),
    update: mock(async () => {}),
  };
}

// ---------------------------------------------------------------------------
// Deps injection setup
// ---------------------------------------------------------------------------

const origRunCompletionDeps = { ..._runCompletionDeps };

let mockRunDeferredRegression: ReturnType<typeof mock>;

beforeEach(() => {
  mockRunDeferredRegression = mock(async (): Promise<DeferredRegressionResult> => MOCK_REGRESSION_SUCCESS);
  _runCompletionDeps.runDeferredRegression =
    mockRunDeferredRegression as typeof _runCompletionDeps.runDeferredRegression;
});

afterEach(() => {
  Object.assign(_runCompletionDeps, origRunCompletionDeps);
  mock.restore();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOpts(config: NaxConfig, prd: PRD, workdir = "/tmp/nax-run-completion-test"): RunCompletionOptions {
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
    workdir,
    statusWriter: makeStatusWriter() as unknown as RunCompletionOptions["statusWriter"],
    config,
  };
}

// ---------------------------------------------------------------------------
// Deferred regression invocation tests
// ---------------------------------------------------------------------------

describe("handleRunCompletion - deferred regression gate", () => {
  test("calls runDeferredRegression when mode is 'deferred' and test command exists", async () => {
    const story = makeStory("US-001", "passed");
    const prd = makePRD([story]);
    const config = makeConfig("deferred", "bun test");

    try {
      await handleRunCompletion(makeOpts(config, prd));
    } catch {
      // Ignore errors from saveRunMetrics / statusWriter in test env
    }

    expect(mockRunDeferredRegression).toHaveBeenCalledTimes(1);
    const call = mockRunDeferredRegression.mock.calls[0][0] as { workdir: string };
    expect(call.workdir).toBe("/tmp/nax-run-completion-test");
  });

  test("does NOT call runDeferredRegression when mode is 'per-story'", async () => {
    const story = makeStory("US-001", "passed");
    const prd = makePRD([story]);
    const config = makeConfig("per-story", "bun test");

    try {
      await handleRunCompletion(makeOpts(config, prd));
    } catch {
      // Ignore errors from disk writes
    }

    expect(mockRunDeferredRegression).not.toHaveBeenCalled();
  });

  test("does NOT call runDeferredRegression when mode is 'disabled'", async () => {
    const story = makeStory("US-001", "passed");
    const prd = makePRD([story]);
    const config = makeConfig("disabled", "bun test");

    try {
      await handleRunCompletion(makeOpts(config, prd));
    } catch {
      // Ignore errors from disk writes
    }

    expect(mockRunDeferredRegression).not.toHaveBeenCalled();
  });

  test("does NOT call runDeferredRegression when no test command is configured", async () => {
    const story = makeStory("US-001", "passed");
    const prd = makePRD([story]);
    // No test command — quality.commands is {}
    const config = makeConfig("deferred", undefined);

    try {
      await handleRunCompletion(makeOpts(config, prd));
    } catch {
      // Ignore errors from disk writes
    }

    expect(mockRunDeferredRegression).not.toHaveBeenCalled();
  });

  test("calls runDeferredRegression with the correct workdir", async () => {
    const story = makeStory("US-001", "passed");
    const prd = makePRD([story]);
    const config = makeConfig("deferred", "bun test");

    try {
      await handleRunCompletion(makeOpts(config, prd, "/custom/workdir"));
    } catch {
      // Ignore errors from disk writes
    }

    expect(mockRunDeferredRegression).toHaveBeenCalledTimes(1);
    const call = mockRunDeferredRegression.mock.calls[0][0] as { workdir: string };
    expect(call.workdir).toBe("/custom/workdir");
  });

  test("calls runDeferredRegression with prd and config", async () => {
    const story = makeStory("US-001", "passed");
    const prd = makePRD([story]);
    const config = makeConfig("deferred", "bun test");

    try {
      await handleRunCompletion(makeOpts(config, prd));
    } catch {
      // Ignore errors from disk writes
    }

    expect(mockRunDeferredRegression).toHaveBeenCalledTimes(1);
    const call = mockRunDeferredRegression.mock.calls[0][0] as {
      config: NaxConfig;
      prd: PRD;
    };
    expect(call.config).toBe(config);
    expect(call.prd).toBe(prd);
  });
});
