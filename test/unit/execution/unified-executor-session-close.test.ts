import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  makeDispatchContext,
  makeMockRuntime,
  makeSessionManager as makeMockSessionManager,
  makePluginRegistry,
  makeStatusWriter,
} from "@test/helpers";
import { DEFAULT_CONFIG } from "@/config";
import type { SequentialExecutionContext } from "@/execution/unified-executor";
import { _unifiedExecutorDeps, executeUnified } from "@/execution/unified-executor";
import type { LoadedHooksConfig } from "@/hooks";
import type { PRD, UserStory } from "@/prd/types";
import { createNoOpCostAggregator } from "@/runtime/cost-aggregator";
import type { ISessionManager } from "@/session";

const EMPTY_HOOKS: LoadedHooksConfig = { hooks: {} };

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

function makeCtx(sessionManager: ISessionManager): SequentialExecutionContext {
  const runtime = makeMockRuntime({
    workdir: "/tmp/nax-test-session-close-output",
    costAggregator: createNoOpCostAggregator(),
    sessionManager,
  });
  return {
    prdPath: "/tmp/test-prd.json",
    workdir: "/tmp/test-workdir",
    config: {
      ...DEFAULT_CONFIG,
      execution: {
        ...DEFAULT_CONFIG.execution,
        maxIterations: 1,
        costLimit: 10,
        iterationDelayMs: 0,
        rectification: {
          ...DEFAULT_CONFIG.execution.rectification,
          maxAttemptsTotal: 2,
        },
      },
    },
    hooks: EMPTY_HOOKS,
    feature: "test-feature",
    dryRun: false,
    useBatch: false,
    pluginRegistry: makePluginRegistry(),
    statusWriter: makeStatusWriter(),
    runId: "run-test",
    startTime: Date.now(),
    batchPlan: [],
    interactionChain: null,
    ...makeDispatchContext({ runtime }),
    sessionManager,
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

    await executeUnified(makeCtx(sessionManager), prd);

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

    await executeUnified(makeCtx(sessionManager), prd);

    expect(sessionManager.closeStory).toHaveBeenCalledWith("US-001");
  });
});
