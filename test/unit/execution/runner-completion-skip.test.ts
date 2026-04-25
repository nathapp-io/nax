/**
 * Tests for rerun skip logic in runCompletionPhase (US-003)
 *
 * Verifies that runCompletionPhase checks getPostRunStatus() before running
 * acceptance and regression phases, and skips them when already passed.
 *
 * AC1: skips both acceptance and regression when getPostRunStatus() returns both "passed"
 * AC2: skips acceptance but runs regression when acceptance "passed" and regression not "passed"
 * AC3: runs both when acceptance.status === "not-run"
 * AC4: runs both when acceptance.status === "failed"
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { NaxConfig } from "../../../src/config";
import { pipelineEventBus } from "../../../src/pipeline/event-bus";
import type { AcceptanceLoopResult } from "../../../src/execution/lifecycle/acceptance-loop";
import {
  _runnerCompletionDeps,
  runCompletionPhase,
  type RunnerCompletionOptions,
} from "../../../src/execution/runner-completion";
import {
  _runCompletionDeps,
} from "../../../src/execution/lifecycle/run-completion";
import type { DeferredRegressionResult } from "../../../src/execution/lifecycle/run-regression";
import type { LoadedHooksConfig } from "../../../src/hooks";
import type { PRD, UserStory } from "../../../src/prd";
import type { PostRunStatus } from "../../../src/execution/status-file";
import { makeNaxConfig } from "../../helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStory(id: string, status: UserStory["status"]): UserStory {
  return {
    id,
    title: `Story ${id}`,
    description: "Test story",
    acceptanceCriteria: ["AC-1"],
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

function makeConfig(acceptanceEnabled = true): NaxConfig {
  return makeNaxConfig({
    acceptance: {
      enabled: acceptanceEnabled,
      maxRetries: 3,
    },
    execution: {
      regressionGate: {
        enabled: true,
        mode: "deferred",
        timeoutSeconds: 30,
        acceptOnTimeout: true,
        maxRectificationAttempts: 2,
      },
    },
    quality: {
      commands: {
        test: "bun test",
      },
    },
  });
}

function makePostRunStatus(
  acceptanceStatus: PostRunStatus["acceptance"]["status"],
  regressionStatus: PostRunStatus["regression"]["status"],
): PostRunStatus {
  return {
    acceptance: { status: acceptanceStatus },
    regression: { status: regressionStatus },
  };
}

function makeStatusWriter(postRunStatus: PostRunStatus = makePostRunStatus("not-run", "not-run")) {
  return {
    setPrd: mock(() => {}),
    setCurrentStory: mock(() => {}),
    setRunStatus: mock(() => {}),
    setPostRunPhase: mock((_phase: string, _update: Record<string, unknown>) => {}),
    update: mock(async () => {}),
    writeFeatureStatus: mock(async () => {}),
    getPostRunStatus: mock(() => postRunStatus),
    resetPostRunStatus: mock(() => {}),
  };
}

const WORKDIR = `/tmp/nax-test-rerun-skip-${randomUUID()}`;

function makeOpts(
  config: NaxConfig,
  prd: PRD,
  statusWriter: ReturnType<typeof makeStatusWriter>,
): RunnerCompletionOptions {
  return {
    config,
    hooks: { hooks: {}, _skipGlobal: false } as unknown as LoadedHooksConfig,
    feature: "test-feature",
    workdir: WORKDIR,
    statusFile: `${WORKDIR}/status.json`,
    logFilePath: undefined,
    runId: "run-001",
    startedAt: new Date().toISOString(),
    startTime: Date.now() - 1000,
    formatterMode: "quiet",
    headless: false,
    prd,
    allStoryMetrics: [],
    totalCost: 0,
    storiesCompleted: 1,
    iterations: 1,
    statusWriter: statusWriter as unknown as RunnerCompletionOptions["statusWriter"],
    pluginRegistry: { getAll: () => [], get: () => undefined } as unknown as RunnerCompletionOptions["pluginRegistry"],
    prdPath: `${WORKDIR}/prd.json`,
  };
}

const defaultAcceptanceResult: AcceptanceLoopResult = {
  success: true,
  prd: makePRD([{ id: "US-001", status: "passed" }]),
  totalCost: 0,
  iterations: 1,
  storiesCompleted: 1,
  prdDirty: false,
};

const defaultRegressionResult: DeferredRegressionResult = {
  success: true,
  failedTests: 0,
  failedTestFiles: [],
  passedTests: 5,
  rectificationAttempts: 0,
  affectedStories: [],
};

const origRunnerDeps = { ..._runnerCompletionDeps };
const origRunDeps = { ..._runCompletionDeps };

beforeEach(() => {
  _runnerCompletionDeps.runAcceptanceLoop = mock(async (): Promise<AcceptanceLoopResult> => defaultAcceptanceResult);
  _runCompletionDeps.runDeferredRegression = mock(async (): Promise<DeferredRegressionResult> => defaultRegressionResult);
});

afterEach(() => {
  Object.assign(_runnerCompletionDeps, origRunnerDeps);
  Object.assign(_runCompletionDeps, origRunDeps);
  pipelineEventBus.clear();
  mock.restore();
});

// ---------------------------------------------------------------------------
// AC1: both phases "passed" → skip acceptance AND regression
// ---------------------------------------------------------------------------

describe("runCompletionPhase - AC1: skips both when both postRun phases are already passed", () => {
  test("does not call runAcceptanceLoop when both phases are passed", async () => {
    const statusWriter = makeStatusWriter(makePostRunStatus("passed", "passed"));
    const prd = makePRD([{ id: "US-001", status: "passed" }]);
    const config = makeConfig(true);

    await runCompletionPhase(makeOpts(config, prd, statusWriter));

    expect(_runnerCompletionDeps.runAcceptanceLoop).not.toHaveBeenCalled();
  });

  test("does not call runDeferredRegression when both phases are passed", async () => {
    const statusWriter = makeStatusWriter(makePostRunStatus("passed", "passed"));
    const prd = makePRD([{ id: "US-001", status: "passed" }]);
    const config = makeConfig(true);

    await runCompletionPhase(makeOpts(config, prd, statusWriter));

    expect(_runCompletionDeps.runDeferredRegression).not.toHaveBeenCalled();
  });

  test("calls getPostRunStatus to check existing phase status", async () => {
    const statusWriter = makeStatusWriter(makePostRunStatus("passed", "passed"));
    const prd = makePRD([{ id: "US-001", status: "passed" }]);
    const config = makeConfig(true);

    await runCompletionPhase(makeOpts(config, prd, statusWriter));

    expect(statusWriter.getPostRunStatus).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC2: acceptance "passed", regression not "passed" → skip acceptance, run regression
// ---------------------------------------------------------------------------

describe("runCompletionPhase - AC2: skips acceptance but runs regression when acceptance already passed", () => {
  test("does not call runAcceptanceLoop when acceptance is already passed", async () => {
    const statusWriter = makeStatusWriter(makePostRunStatus("passed", "not-run"));
    const prd = makePRD([{ id: "US-001", status: "passed" }]);
    const config = makeConfig(true);

    await runCompletionPhase(makeOpts(config, prd, statusWriter));

    expect(_runnerCompletionDeps.runAcceptanceLoop).not.toHaveBeenCalled();
  });

  test("calls runDeferredRegression when acceptance is passed but regression is not-run", async () => {
    const statusWriter = makeStatusWriter(makePostRunStatus("passed", "not-run"));
    const prd = makePRD([{ id: "US-001", status: "passed" }]);
    const config = makeConfig(true);

    await runCompletionPhase(makeOpts(config, prd, statusWriter));

    expect(_runCompletionDeps.runDeferredRegression).toHaveBeenCalledTimes(1);
  });

  test("calls runDeferredRegression when acceptance is passed but regression is failed", async () => {
    const statusWriter = makeStatusWriter(makePostRunStatus("passed", "failed"));
    const prd = makePRD([{ id: "US-001", status: "passed" }]);
    const config = makeConfig(true);

    await runCompletionPhase(makeOpts(config, prd, statusWriter));

    expect(_runCompletionDeps.runDeferredRegression).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// AC3: acceptance "not-run" → run both phases
// ---------------------------------------------------------------------------

describe("runCompletionPhase - AC3: runs both when acceptance.status is not-run", () => {
  test("calls runAcceptanceLoop when acceptance is not-run and PRD is complete", async () => {
    const statusWriter = makeStatusWriter(makePostRunStatus("not-run", "not-run"));
    const prd = makePRD([{ id: "US-001", status: "passed" }]);
    const config = makeConfig(true);

    await runCompletionPhase(makeOpts(config, prd, statusWriter));

    expect(_runnerCompletionDeps.runAcceptanceLoop).toHaveBeenCalledTimes(1);
  });

  test("calls runDeferredRegression when acceptance is not-run and deferred mode is set", async () => {
    const statusWriter = makeStatusWriter(makePostRunStatus("not-run", "not-run"));
    const prd = makePRD([{ id: "US-001", status: "passed" }]);
    const config = makeConfig(true);

    await runCompletionPhase(makeOpts(config, prd, statusWriter));

    expect(_runCompletionDeps.runDeferredRegression).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// AC4: acceptance "failed" → run both phases
// ---------------------------------------------------------------------------

describe("runCompletionPhase - AC4: runs both when acceptance.status is failed", () => {
  test("calls runAcceptanceLoop when acceptance previously failed", async () => {
    const statusWriter = makeStatusWriter(makePostRunStatus("failed", "not-run"));
    const prd = makePRD([{ id: "US-001", status: "passed" }]);
    const config = makeConfig(true);

    await runCompletionPhase(makeOpts(config, prd, statusWriter));

    expect(_runnerCompletionDeps.runAcceptanceLoop).toHaveBeenCalledTimes(1);
  });

  test("calls runDeferredRegression when acceptance previously failed", async () => {
    const statusWriter = makeStatusWriter(makePostRunStatus("failed", "not-run"));
    const prd = makePRD([{ id: "US-001", status: "passed" }]);
    const config = makeConfig(true);

    await runCompletionPhase(makeOpts(config, prd, statusWriter));

    expect(_runCompletionDeps.runDeferredRegression).toHaveBeenCalledTimes(1);
  });

  test("calls runDeferredRegression when both acceptance and regression previously failed", async () => {
    const statusWriter = makeStatusWriter(makePostRunStatus("failed", "failed"));
    const prd = makePRD([{ id: "US-001", status: "passed" }]);
    const config = makeConfig(true);

    await runCompletionPhase(makeOpts(config, prd, statusWriter));

    expect(_runCompletionDeps.runDeferredRegression).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Guard: no skip when acceptance is disabled (config gate still applies)
// ---------------------------------------------------------------------------

describe("runCompletionPhase - skip only applies when acceptance/regression config is active", () => {
  test("does not call runAcceptanceLoop when acceptance is disabled, regardless of status", async () => {
    const statusWriter = makeStatusWriter(makePostRunStatus("not-run", "not-run"));
    const prd = makePRD([{ id: "US-001", status: "passed" }]);
    // acceptance disabled
    const config = makeConfig(false);

    await runCompletionPhase(makeOpts(config, prd, statusWriter));

    expect(_runnerCompletionDeps.runAcceptanceLoop).not.toHaveBeenCalled();
  });
});
