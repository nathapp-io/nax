import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../../../src/config/defaults";
import { _runCompletionDeps, handleRunCompletion } from "../../../../src/execution/lifecycle/run-completion";
import type { ISessionManager } from "../../../../src/session";

const makeStatusWriter = () => ({
  setPrd: mock(() => {}),
  setCurrentStory: mock(() => {}),
  setRunStatus: mock(() => {}),
  setPostRunPhase: mock(() => {}),
  update: mock(async () => {}),
});

const makePrd = () => ({
  project: "test-project",
  feature: "test-feature",
  branchName: "test-branch",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  userStories: [],
});

describe("handleRunCompletion session teardown", () => {
  const originalCloseAllRunSessions = _runCompletionDeps.closeAllRunSessions;
  const originalRunDeferredRegression = _runCompletionDeps.runDeferredRegression;

  beforeEach(() => {
    _runCompletionDeps.closeAllRunSessions = mock(async () => 0);
    _runCompletionDeps.runDeferredRegression = mock(async () => ({
      success: true,
      failedTests: 0,
      failedTestFiles: [],
      passedTests: 0,
      rectificationAttempts: 0,
      affectedStories: [],
    }));
  });

  afterEach(() => {
    _runCompletionDeps.closeAllRunSessions = originalCloseAllRunSessions;
    _runCompletionDeps.runDeferredRegression = originalRunDeferredRegression;
    mock.restore();
  });

  test("calls closeAllRunSessions when sessionManager is provided", async () => {
    await handleRunCompletion({
      runId: "run-1",
      feature: "test-feature",
      startedAt: new Date().toISOString(),
      prd: makePrd() as never,
      allStoryMetrics: [],
      totalCost: 0,
      storiesCompleted: 0,
      iterations: 1,
      startTime: Date.now() - 100,
      workdir: "/tmp/workdir",
      statusWriter: makeStatusWriter() as never,
      config: {
        ...DEFAULT_CONFIG,
        execution: {
          ...DEFAULT_CONFIG.execution,
          regressionGate: {
            ...DEFAULT_CONFIG.execution.regressionGate,
            mode: "disabled",
          },
        },
      } as never,
      sessionManager: { closeStory: mock(() => []), listActive: mock(() => []) } as unknown as ISessionManager,
    });

    expect(_runCompletionDeps.closeAllRunSessions).toHaveBeenCalledTimes(1);
  });

  test("does not call closeAllRunSessions when sessionManager is omitted", async () => {
    await handleRunCompletion({
      runId: "run-1",
      feature: "test-feature",
      startedAt: new Date().toISOString(),
      prd: makePrd() as never,
      allStoryMetrics: [],
      totalCost: 0,
      storiesCompleted: 0,
      iterations: 1,
      startTime: Date.now() - 100,
      workdir: "/tmp/workdir",
      statusWriter: makeStatusWriter() as never,
      config: {
        ...DEFAULT_CONFIG,
        execution: {
          ...DEFAULT_CONFIG.execution,
          regressionGate: {
            ...DEFAULT_CONFIG.execution.regressionGate,
            mode: "disabled",
          },
        },
      } as never,
    });

    expect(_runCompletionDeps.closeAllRunSessions).not.toHaveBeenCalled();
  });
});
