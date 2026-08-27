/**
 * Shared test fixtures for parallel metrics integration tests.
 * Imported by runner-parallel-metrics.test.ts,
 * runner-parallel-metrics-cost-duration.test.ts and
 * runner-parallel-metrics-rectification-events.test.ts.
 */

import {
  makeDispatchContext,
  makePluginRegistry,
  makePRD,
  makeStatusWriter,
  makeStory,
  makeTestRuntime,
} from "@test/helpers";
import type { NaxConfig } from "@/config";
import { DEFAULT_CONFIG } from "@/config/defaults";
import type { SequentialExecutionContext } from "@/execution/unified-executor";
import type { LoadedHooksConfig } from "@/hooks";
import type { PRD, UserStory } from "@/prd/types";
import { createNoOpCostAggregator } from "@/runtime";

const EMPTY_HOOKS: LoadedHooksConfig = { hooks: {} };

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

export interface MakeCtxOverrides {
  parallelCount?: number;
  costLimit?: number;
  maxIterations?: number;
}

export function makeCtx(overrides: MakeCtxOverrides = {}): SequentialExecutionContext {
  const { parallelCount, costLimit = 100, maxIterations = 1 } = overrides;
  const config: NaxConfig = {
    ...DEFAULT_CONFIG,
    execution: {
      ...DEFAULT_CONFIG.execution,
      maxIterations,
      costLimit,
      iterationDelayMs: 0,
      rectification: {
        ...DEFAULT_CONFIG.execution.rectification,
        maxAttemptsTotal: 2,
      },
    },
  };
  // No-op aggregator keeps cost accounting deterministic: the tests drive
  // enforceCostLimit through mocked batch totals only.
  const runtime = makeTestRuntime({ config, costAggregator: createNoOpCostAggregator() });
  return {
    prdPath: "/tmp/test-prd.json",
    workdir: "/tmp/test-workdir",
    config,
    hooks: EMPTY_HOOKS,
    feature: "test-feature",
    featureDir: "/tmp/test-feature-dir",
    dryRun: false,
    useBatch: false,
    pluginRegistry: makePluginRegistry(),
    statusWriter: makeStatusWriter(),
    runId: "run-test",
    startTime: Date.now(),
    batchPlan: [],
    interactionChain: null,
    parallelCount,
    ...makeDispatchContext({ runtime }),
  };
}
