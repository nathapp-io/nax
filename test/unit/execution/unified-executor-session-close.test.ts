import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _unifiedExecutorDeps, executeUnified } from "@/execution/unified-executor";
import type { PRD, UserStory } from "@/prd/types";
import type { ISessionManager } from "@/session";
import { makeSessionManager as makeMockSessionManager } from "@test/helpers";

function makePendingStory(id: string): UserStory {
  return {
    id,
    title: `Story ${id}`,
    description: `Description for ${id}`,
    acceptanceCriteria: [],
    tags: [],
    dependencies: [],
    status: "pending" as const,
    passes: false,
    escalations: [],
    attempts: 0,
  };
}

function makePrd(stories: UserStory[]): PRD {
  return {
    project: "test-project",
    feature: "test-feature",
    branchName: "test-branch",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: stories,
  };
}

function makeSessionManager(): ISessionManager {
  return makeMockSessionManager({
    create: mock(() => {
      throw new Error("unused");
    }),
    get: mock(() => null),
    transition: mock(() => {
      throw new Error("unused");
    }),
    bindHandle: mock(() => {
      throw new Error("unused");
    }),
    handoff: mock(() => {
      throw new Error("unused");
    }),
    resume: mock(() => null),
    closeStory: mock(() => []),
    listActive: mock(() => []),
    getForStory: mock(() => []),
    sweepOrphans: mock(() => 0),
  });
}

function makeCtx(sessionManager: ISessionManager) {
  return {
    prdPath: "/tmp/test-prd.json",
    workdir: "/tmp/test-workdir",
    config: {
      execution: {
        maxIterations: 1,
        costLimit: 10,
        iterationDelayMs: 0,
        rectification: { maxAttemptsTotal: 2 },
      },
      autoMode: { defaultAgent: "claude-code" },
      interaction: {},
    },
    hooks: {},
    feature: "test-feature",
    dryRun: false,
    useBatch: false,
    pluginRegistry: {
      getReporters: () => [],
      getContextProviders: () => [],
    },
    statusWriter: {
      setPrd: mock(() => {}),
      setCurrentStory: mock(() => {}),
      setRunStatus: mock(() => {}),
      update: mock(async () => {}),
    },
    runId: "run-test",
    startTime: Date.now(),
    batchPlan: [],
    interactionChain: null,
    sessionManager,
    runtime: {
      outputDir: "/tmp/nax-test-session-close-output",
      costAggregator: {
        snapshot: () => ({
          totalCostUsd: 0,
          totalEstimatedCostUsd: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          callCount: 0,
          errorCount: 0,
        }),
        byStage: () => ({}),
        byStory: () => ({}),
        byAgent: () => ({}),
        record: () => {},
        recordError: () => {},
        recordOperationSummary: () => {},
        drain: async () => {},
      },
    },
  };
}

describe("unified-executor session close policy", () => {
  let originalRunIteration: typeof _unifiedExecutorDeps.runIteration;

  beforeEach(() => {
    originalRunIteration = _unifiedExecutorDeps.runIteration;
  });

  afterEach(() => {
    _unifiedExecutorDeps.runIteration = originalRunIteration;
    mock.restore();
  });

  test("does not close story sessions when finalAction is escalate", async () => {
    const sessionManager = makeSessionManager();
    const story = makePendingStory("US-001");
    const prd = makePrd([story]);
    _unifiedExecutorDeps.runIteration = mock(async () => ({
      prd,
      storiesCompletedDelta: 0,
      costDelta: 0,
      prdDirty: false,
      finalAction: "escalate",
    }));

    await executeUnified(makeCtx(sessionManager) as never, prd as never);

    expect(sessionManager.closeStory).not.toHaveBeenCalled();
  });

  test("closes story sessions when finalAction is fail", async () => {
    const sessionManager = makeSessionManager();
    const story = makePendingStory("US-001");
    const prd = makePrd([story]);
    _unifiedExecutorDeps.runIteration = mock(async () => ({
      prd,
      storiesCompletedDelta: 0,
      costDelta: 0,
      prdDirty: false,
      finalAction: "fail",
    }));

    await executeUnified(makeCtx(sessionManager) as never, prd as never);

    expect(sessionManager.closeStory).toHaveBeenCalledWith("US-001");
  });
});
