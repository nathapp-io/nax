/**
 * Shared test fixtures for parallel metrics integration tests.
 * Imported by runner-parallel-metrics-cost-duration.test.ts and
 * runner-parallel-metrics-rectification-events.test.ts.
 */

import { mock } from "bun:test";
import type { UserStory, PRD } from "../../../src/prd/types";

export function makePendingStory(id: string): UserStory {
  return {
    id,
    title: `Story ${id}`,
    description: `Description for ${id}`,
    acceptanceCriteria: [`AC-1: ${id} works`],
    tags: [],
    dependencies: [],
    status: "pending" as const,
    passes: false,
    escalations: [],
    attempts: 0,
    routing: {
      complexity: "simple" as const,
      modelTier: "fast" as const,
      testStrategy: "test-after" as const,
      reasoning: "test",
    },
    priorFailures: [],
  } as unknown as UserStory;
}

export function makePrd(stories: UserStory[]): PRD {
  return {
    project: "test-project",
    feature: "test-feature",
    branchName: "feat/test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: stories,
  } as unknown as PRD;
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
        rectification: { maxRetries: 2 },
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
    parallelCount,
  };
}
