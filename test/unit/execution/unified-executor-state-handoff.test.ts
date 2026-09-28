/**
 * Loop-state handoff between executeUnified and its dispatch phases.
 *
 * File: unified-executor-state-handoff.test.ts
 * Covers (docs/plans/REVIEW-complexity-drain.md §1):
 *   1.1 a pre-check skip on the LAST iteration hands the updated PRD to the result
 *   1.2 a heartbeat tick after statusWriter.update reads the new cost, not the previous one
 *   (follow-up) a tick mid-story reports aggregator spend the loop has not folded in yet
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeDispatchContext, makeMockRuntime, makePluginRegistry, makeStatusWriter } from "@test/helpers";
import { DEFAULT_CONFIG } from "@/config";
import { _heartbeatDeps } from "@/execution/crash-heartbeat";
import { stopHeartbeat } from "@/execution/crash-recovery";
import { _unifiedExecutorDeps, executeUnified, type SequentialExecutionContext } from "@/execution/unified-executor";
import type { LoadedHooksConfig } from "@/hooks";
import type { EscalationAttempt, PRD, UserStory } from "@/prd/types";
import { createNoOpCostAggregator, type ICostAggregator } from "@/runtime";

const EMPTY_HOOKS: LoadedHooksConfig = { hooks: {} };

function makePendingStory(id: string): UserStory {
  const escalations: EscalationAttempt[] = [];
  return {
    id,
    title: `Story ${id}`,
    description: `Description for ${id}`,
    acceptanceCriteria: [],
    tags: [],
    dependencies: [],
    status: "pending",
    passes: false,
    attempts: 0,
    escalations,
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

function makeCtx(
  overrides: {
    parallelCount?: number;
    statusWriter?: SequentialExecutionContext["statusWriter"];
    costAggregator?: ICostAggregator;
  } = {},
): SequentialExecutionContext {
  const { costAggregator, ...rest } = overrides;
  return {
    prdPath: "/tmp/test-prd.json",
    workdir: "/tmp/test-workdir",
    config: {
      ...DEFAULT_CONFIG,
      acceptance: { ...DEFAULT_CONFIG.acceptance, enabled: false },
      execution: { ...DEFAULT_CONFIG.execution, maxIterations: 1, costLimit: 100, iterationDelayMs: 0 },
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
    ...makeDispatchContext({ runtime: makeMockRuntime({ workdir: "/tmp/nax-test-state-handoff", costAggregator }) }),
    ...rest,
  };
}

const savedExecutorDeps = { ..._unifiedExecutorDeps };
const savedHeartbeatDeps = { ..._heartbeatDeps };

beforeEach(() => {
  Object.assign(_unifiedExecutorDeps, savedExecutorDeps);
  Object.assign(_heartbeatDeps, savedHeartbeatDeps);
});

afterEach(() => {
  stopHeartbeat();
  Object.assign(_unifiedExecutorDeps, savedExecutorDeps);
  Object.assign(_heartbeatDeps, savedHeartbeatDeps);
  mock.restore();
});

describe("1.1 — pre-check skip on the last iteration", () => {
  function skipWithFailedStory(story: UserStory) {
    const failedPrd = makePrd([{ ...story, status: "failed" }]);
    _unifiedExecutorDeps.preIterationTierCheck = mock(async () => ({
      shouldSkipIteration: true,
      prdDirty: true,
      prd: failedPrd,
    }));
    _unifiedExecutorDeps.runIteration = mock(async () => {
      throw new Error("runIteration must not run after a skip");
    });
    return failedPrd;
  }

  test("sequential dispatch: result.prd is the PRD the pre-check returned", async () => {
    const story = makePendingStory("US-001");
    const failedPrd = skipWithFailedStory(story);

    const result = await executeUnified(makeCtx(), makePrd([story]));

    expect(result.exitReason).toBe("max-iterations");
    expect(result.prd).toBe(failedPrd);
  });

  test("single story in parallel mode: result.prd is the PRD the pre-check returned", async () => {
    const story = makePendingStory("US-001");
    const failedPrd = skipWithFailedStory(story);
    _unifiedExecutorDeps.selectIndependentBatch = mock(() => [story]);

    const result = await executeUnified(makeCtx({ parallelCount: 2 }), makePrd([story]));

    expect(result.exitReason).toBe("max-iterations");
    expect(result.prd).toBe(failedPrd);
  });
});

/**
 * Holds the heartbeat's first sleep until `tick()` releases it; `tick()` then
 * resolves once that tick has written the status file. Later sleeps park until
 * stopHeartbeat() aborts them.
 */
function armOneHeartbeatTick() {
  const costs: number[] = [];
  let release: () => void = () => {};
  let written: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    written = resolve;
  });
  let sleepCalls = 0;
  _heartbeatDeps.sleep = mock((_ms: number, signal?: AbortSignal) => {
    sleepCalls += 1;
    if (sleepCalls === 1) {
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    return new Promise<void>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
  });
  const statusWriter = makeStatusWriter({
    update: mock(async (cost: number, _iterations: number, extra?: { lastHeartbeat?: string }) => {
      if (extra?.lastHeartbeat === undefined) return;
      costs.push(cost);
      written();
    }),
  });
  const tick = async () => {
    release();
    await done;
  };
  return { costs, statusWriter, tick };
}

describe("1.2 — heartbeat cost during the post-iteration tail", () => {
  test("a tick landing after statusWriter.update writes the iteration's reconciled cost", async () => {
    const story = makePendingStory("US-001");
    const prd = makePrd([story]);
    const heartbeat = armOneHeartbeatTick();
    const ownUpdate = heartbeat.statusWriter.update;
    heartbeat.statusWriter.update = mock(
      async (cost: number, iterations: number, extra?: { lastHeartbeat?: string }) => {
        await ownUpdate(cost, iterations, extra);
        // The dispatch phase's own update: fire one heartbeat tick while the phase is still running.
        if (extra?.lastHeartbeat === undefined) await heartbeat.tick();
      },
    );
    _unifiedExecutorDeps.runIteration = mock(async () => ({
      prd,
      storiesCompletedDelta: 0,
      costDelta: 5,
      prdDirty: false,
    }));

    await executeUnified(makeCtx({ statusWriter: heartbeat.statusWriter }), prd);

    expect(heartbeat.costs).toEqual([5]);
  });

  test("a tick mid-story reports aggregator spend the loop has not folded in yet", async () => {
    const story = makePendingStory("US-001");
    const prd = makePrd([story]);
    const heartbeat = armOneHeartbeatTick();
    const noOp = createNoOpCostAggregator();
    let spentUsd = 0;
    const costAggregator: ICostAggregator = {
      ...noOp,
      snapshot: () => ({ ...noOp.snapshot(), totalCostUsd: spentUsd }),
    };
    _unifiedExecutorDeps.runIteration = mock(async () => {
      spentUsd = 12;
      await heartbeat.tick();
      return { prd, storiesCompletedDelta: 0, costDelta: 12, prdDirty: false };
    });

    await executeUnified(makeCtx({ statusWriter: heartbeat.statusWriter, costAggregator }), prd);

    expect(heartbeat.costs).toEqual([12]);
  });
});
