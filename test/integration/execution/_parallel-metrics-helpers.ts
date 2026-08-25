/**
 * Shared test fixtures for parallel metrics integration tests.
 * Imported by runner-parallel-metrics-cost-duration.test.ts and
 * runner-parallel-metrics-rectification-events.test.ts.
 */

import { mock } from "bun:test";
import type { PRD, UserStory } from "@/prd/types";
import { makePRD, makeStory } from "@test/helpers";

export function makePendingStory(id: string): UserStory {
  return makeStory({
    id,
    title: `Story ${id}`,
    description: `Description for ${id}`,
    acceptanceCriteria: [`AC-1: ${id} works`],
    routing: {
      complexity: "simple",
      modelTier: "fast",
      testStrategy: "test-after",
      reasoning: "test",
    },
    priorFailures: [],
  });
}

export function makePrd(stories: UserStory[]): PRD {
  return makePRD({
    project: "test-project",
    feature: "test-feature",
    branchName: "feat/test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: stories,
  });
}

export function makeCtx(overrides: { parallelCount?: number; costLimit?: number; maxIterations?: number } = {}) {
  const { parallelCount, costLimit = 100, maxIterations = 1 } = overrides;
  return {
    prdPath: "/tmp/test-prd.json",
    workdir: "/tmp/test-workdir",
    config: {
      execution: {
        maxIterations,
        costLimit,
        iterationDelayMs: 0,
        rectification: { maxAttemptsTotal: 2 },
      },
      agent: { default: "claude-code" },
      interaction: {},
    },
    hooks: {},
    feature: "test-feature",
    featureDir: "/tmp/test-feature-dir",
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
    runtime: {
      outputDir: "/tmp/nax-test-parallel-metrics-output",
      // nax#1709: parallel metrics read these run-scoped stores.
      agentFallbacks: new Map(),
      runtimeCrashRetries: new Map(),
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
    parallelCount,
  };
}
