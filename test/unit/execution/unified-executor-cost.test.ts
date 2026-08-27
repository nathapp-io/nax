/**
 * Unit tests for US-003: Unify executors — cost-limit exit after parallel batch.
 *
 * File: unified-executor-cost.test.ts
 * Covers:
 *   AC-7 cost-limit exit after parallel batch (runtime)
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeDispatchContext, makeMockRuntime, makePluginRegistry, makeStatusWriter } from "@test/helpers";
import { DEFAULT_CONFIG } from "@/config";
import type { InteractionConfig } from "@/config/runtime-types";
import type { SequentialExecutionContext } from "@/execution/unified-executor";
import type { LoadedHooksConfig } from "@/hooks";
import type { InteractionPlugin, InteractionRequest, InteractionResponse } from "@/interaction";
import { InteractionChain } from "@/interaction";
import { pipelineEventBus } from "@/pipeline";
import type { EscalationAttempt, PRD, UserStory } from "@/prd/types";

const EMPTY_HOOKS: LoadedHooksConfig = { hooks: {} };

// ─────────────────────────────────────────────────────────────────────────────
// Test fixture helpers
// ─────────────────────────────────────────────────────────────────────────────

function makePendingStory(id: string): UserStory {
  const acceptanceCriteria: string[] = [];
  const tags: string[] = [];
  const dependencies: string[] = [];
  const escalations: EscalationAttempt[] = [];
  return {
    id,
    title: `Story ${id}`,
    description: `Description for ${id}`,
    acceptanceCriteria,
    tags,
    dependencies,
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

function makeCtx(overrides: { parallelCount?: number } = {}): SequentialExecutionContext {
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
    ...makeDispatchContext({ runtime: makeMockRuntime({ workdir: "/tmp/nax-test-cost-output" }) }),
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AC-7 — cost-limit exit after parallel batch (runtime)
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-7 — cost-limit exit after parallel batch (runtime)", () => {
  let deps: Record<string, unknown>;
  let origRunParallelBatch: unknown;
  let origSelectIndependentBatch: unknown;

  beforeEach(async () => {
    const mod = await import("@/execution/unified-executor");
    deps = (mod as Record<string, unknown>)._unifiedExecutorDeps as Record<string, unknown>;
    origRunParallelBatch = deps.runParallelBatch;
    origSelectIndependentBatch = deps.selectIndependentBatch;
  });

  afterEach(() => {
    if (deps) {
      deps.runParallelBatch = origRunParallelBatch;
      deps.selectIndependentBatch = origSelectIndependentBatch;
    }
    mock.restore();
  });

  test("executeUnified returns exitReason 'cost-limit' when parallel batch pushes totalCost over the configured limit", async () => {
    const story1 = makePendingStory("US-001");
    const story2 = makePendingStory("US-002");

    deps.selectIndependentBatch = mock(() => [story1, story2]);
    deps.runParallelBatch = mock(async () => ({
      completed: [story1, story2],
      failed: [],
      mergeConflicts: [],
      storyCosts: new Map<string, number>([
        [story1.id, 3],
        [story2.id, 3],
      ]),
      totalCost: 6,
    }));

    const { executeUnified } = await import("@/execution/unified-executor");
    const prd = makePrd([story1, story2]);
    const baseCtx = makeCtx({ parallelCount: 2 });
    const ctx = {
      ...baseCtx,
      config: {
        ...baseCtx.config,
        execution: {
          ...baseCtx.config.execution,
          costLimit: 5,
          maxIterations: 2,
        },
      },
    };

    const result = await executeUnified(ctx, prd);
    expect(result.exitReason).toBe("cost-limit");
    expect(result.totalCost).toBeGreaterThanOrEqual(6);
  });

  test("executeUnified does NOT exit with cost-limit when parallel batch cost stays below limit", async () => {
    const story1 = makePendingStory("US-001");
    const story2 = makePendingStory("US-002");

    deps.selectIndependentBatch = mock(() => [story1, story2]);
    deps.runParallelBatch = mock(async () => ({
      completed: [story1, story2],
      failed: [],
      mergeConflicts: [],
      storyCosts: new Map<string, number>([
        [story1.id, 1],
        [story2.id, 1],
      ]),
      totalCost: 2,
    }));

    const { executeUnified } = await import("@/execution/unified-executor");
    const prd = makePrd([story1, story2]);
    const baseCtx = makeCtx({ parallelCount: 2 });
    const ctx = {
      ...baseCtx,
      config: {
        ...baseCtx.config,
        execution: {
          ...baseCtx.config.execution,
          costLimit: 100,
          maxIterations: 1,
        },
      },
    };

    const result = await executeUnified(ctx, prd).catch(() => ({ exitReason: "error" }) as { exitReason: string });
    expect(result.exitReason).not.toBe("cost-limit");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BUG-61 — cost-warning trigger must also fire on the parallel/batch path
// ─────────────────────────────────────────────────────────────────────────────

describe("BUG-61 — cost-warning trigger fires after a parallel batch, not just sequentially", () => {
  let deps: Record<string, unknown>;
  let origRunParallelBatch: unknown;
  let origSelectIndependentBatch: unknown;

  beforeEach(async () => {
    const mod = await import("@/execution/unified-executor");
    deps = (mod as Record<string, unknown>)._unifiedExecutorDeps as Record<string, unknown>;
    origRunParallelBatch = deps.runParallelBatch;
    origSelectIndependentBatch = deps.selectIndependentBatch;
  });

  afterEach(() => {
    if (deps) {
      deps.runParallelBatch = origRunParallelBatch;
      deps.selectIndependentBatch = origSelectIndependentBatch;
    }
    mock.restore();
  });

  test("fires the cost-warning trigger once totalCost crosses 80% of costLimit after a parallel batch", async () => {
    const story1 = makePendingStory("US-001");
    const story2 = makePendingStory("US-002");

    deps.selectIndependentBatch = mock(() => [story1, story2]);
    deps.runParallelBatch = mock(async () => ({
      completed: [story1, story2],
      failed: [],
      mergeConflicts: [],
      storyCosts: new Map<string, number>([
        [story1.id, 4],
        [story2.id, 4],
      ]),
      totalCost: 8, // 80% of a costLimit of 10
    }));

    const sentTriggers: string[] = [];
    const fakePlugin: InteractionPlugin = {
      name: "fake",
      send: async (request: InteractionRequest) => {
        const trigger = (request.metadata as { trigger?: string } | undefined)?.trigger;
        if (trigger) sentTriggers.push(trigger);
      },
      receive: async (requestId: string): Promise<InteractionResponse> => ({
        requestId,
        action: "reject",
        respondedBy: "test",
        respondedAt: Date.now(),
      }),
    };
    const interactionChain = new InteractionChain({ defaultTimeout: 1000, defaultFallback: "continue" });
    interactionChain.register(fakePlugin, 0);

    const { executeUnified } = await import("@/execution/unified-executor");
    const prd = makePrd([story1, story2]);
    const baseCtx = makeCtx({ parallelCount: 2 });
    const costWarningInteraction: InteractionConfig = {
      plugin: "cli",
      config: {},
      defaults: { timeout: 600000 },
      triggers: { "cost-warning": { enabled: true, threshold: 0.8 } },
    };
    const ctx: SequentialExecutionContext = {
      ...baseCtx,
      interactionChain,
      config: {
        ...baseCtx.config,
        interaction: costWarningInteraction,
        execution: {
          ...baseCtx.config.execution,
          costLimit: 10, // totalCost=8 is 80% of this — crosses the warning threshold but not the hard limit
          maxIterations: 1,
        },
      },
    };

    await executeUnified(ctx, prd).catch(() => undefined);

    expect(sentTriggers).toContain("cost-warning");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BUG-6 / D-4 — parallel cost-limit stop gets full parity with sequential:
// emits run:paused (or run:resumed) and consults the cost-exceeded trigger
// instead of silently returning "cost-limit" with no event and no prompt.
// ─────────────────────────────────────────────────────────────────────────────

describe("BUG-6 — parallel cost-limit stop has parity with sequential (event + trigger)", () => {
  let deps: Record<string, unknown>;
  let origRunParallelBatch: unknown;
  let origSelectIndependentBatch: unknown;
  let capturedRunPaused: Array<{ reason: string; cost: number }>;
  let capturedRunResumed: number;
  let unsubPaused: (() => void) | undefined;
  let unsubResumed: (() => void) | undefined;

  beforeEach(async () => {
    const mod = await import("@/execution/unified-executor");
    deps = (mod as Record<string, unknown>)._unifiedExecutorDeps as Record<string, unknown>;
    origRunParallelBatch = deps.runParallelBatch;
    origSelectIndependentBatch = deps.selectIndependentBatch;
    capturedRunPaused = [];
    capturedRunResumed = 0;
    unsubPaused = pipelineEventBus.on("run:paused", (event) => {
      capturedRunPaused.push({ reason: (event as { reason: string }).reason, cost: (event as { cost: number }).cost });
    });
    unsubResumed = pipelineEventBus.on("run:resumed", () => {
      capturedRunResumed++;
    });
  });

  afterEach(() => {
    if (deps) {
      deps.runParallelBatch = origRunParallelBatch;
      deps.selectIndependentBatch = origSelectIndependentBatch;
    }
    unsubPaused?.();
    unsubResumed?.();
    mock.restore();
  });

  test("emits run:paused with reason and cost when no interactionChain is present (no silent stop)", async () => {
    const story1 = makePendingStory("US-001");
    const story2 = makePendingStory("US-002");

    deps.selectIndependentBatch = mock(() => [story1, story2]);
    deps.runParallelBatch = mock(async () => ({
      completed: [story1, story2],
      failed: [],
      mergeConflicts: [],
      storyCosts: new Map<string, number>([
        [story1.id, 3],
        [story2.id, 3],
      ]),
      totalCost: 6,
    }));

    const { executeUnified } = await import("@/execution/unified-executor");
    const prd = makePrd([story1, story2]);
    const baseCtx = makeCtx({ parallelCount: 2 });
    const ctx = {
      ...baseCtx,
      config: {
        ...baseCtx.config,
        execution: { ...baseCtx.config.execution, costLimit: 5, maxIterations: 2 },
      },
    };

    const result = await executeUnified(ctx, prd);

    expect(result.exitReason).toBe("cost-limit");
    expect(capturedRunPaused).toHaveLength(1);
    expect(capturedRunPaused[0].reason).toContain("Cost limit reached");
    expect(capturedRunPaused[0].cost).toBeGreaterThanOrEqual(6);
    expect(capturedRunResumed).toBe(0);
  });

  test("consults the cost-exceeded trigger and does not stop when the user approves continuing", async () => {
    const story1 = makePendingStory("US-001");
    const story2 = makePendingStory("US-002");

    deps.selectIndependentBatch = mock(() => [story1, story2]);
    deps.runParallelBatch = mock(async () => ({
      completed: [story1, story2],
      failed: [],
      mergeConflicts: [],
      storyCosts: new Map<string, number>([
        [story1.id, 3],
        [story2.id, 3],
      ]),
      totalCost: 6,
    }));

    const fakePlugin: InteractionPlugin = {
      name: "fake-approve",
      send: async () => {},
      receive: async (requestId: string): Promise<InteractionResponse> => ({
        requestId,
        action: "approve",
        respondedBy: "test",
        respondedAt: Date.now(),
      }),
    };
    const interactionChain = new InteractionChain({ defaultTimeout: 1000, defaultFallback: "continue" });
    interactionChain.register(fakePlugin, 0);

    const { executeUnified } = await import("@/execution/unified-executor");
    const prd = makePrd([story1, story2]);
    const baseCtx = makeCtx({ parallelCount: 2 });
    const costExceededInteraction: InteractionConfig = {
      plugin: "cli",
      config: {},
      defaults: { timeout: 600000 },
      triggers: { "cost-exceeded": { enabled: true } },
    };
    const ctx: SequentialExecutionContext = {
      ...baseCtx,
      interactionChain,
      config: {
        ...baseCtx.config,
        interaction: costExceededInteraction,
        execution: { ...baseCtx.config.execution, costLimit: 5, maxIterations: 2 },
      },
    };

    // The next iteration reloads the PRD from disk (a path that doesn't exist in
    // this fixture) — tolerate that the same way the existing "does NOT exit"
    // AC-7 test above does. What matters here is the trigger was consulted and
    // the run did not silently stop with exitReason "cost-limit".
    const result = await executeUnified(ctx, prd).catch(() => ({ exitReason: "error" }) as { exitReason: string });

    expect(result.exitReason).not.toBe("cost-limit");
    expect(capturedRunResumed).toBe(1);
    expect(capturedRunPaused).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BUG-13 — parallel batch path was missing the statusWriter update sequential
// dispatch already performs after every iteration.
// ─────────────────────────────────────────────────────────────────────────────

describe("BUG-13 — parallel batch updates statusWriter after batch completion", () => {
  let deps: Record<string, unknown>;
  let origRunParallelBatch: unknown;
  let origSelectIndependentBatch: unknown;

  beforeEach(async () => {
    const mod = await import("@/execution/unified-executor");
    deps = (mod as Record<string, unknown>)._unifiedExecutorDeps as Record<string, unknown>;
    origRunParallelBatch = deps.runParallelBatch;
    origSelectIndependentBatch = deps.selectIndependentBatch;
  });

  afterEach(() => {
    if (deps) {
      deps.runParallelBatch = origRunParallelBatch;
      deps.selectIndependentBatch = origSelectIndependentBatch;
    }
    mock.restore();
  });

  test("calls statusWriter.setPrd/setCurrentStory/update after a completed parallel batch", async () => {
    const story1 = makePendingStory("US-001");
    const story2 = makePendingStory("US-002");

    deps.selectIndependentBatch = mock(() => [story1, story2]);
    deps.runParallelBatch = mock(async () => ({
      completed: [story1, story2],
      failed: [],
      mergeConflicts: [],
      storyCosts: new Map<string, number>([
        [story1.id, 1],
        [story2.id, 1],
      ]),
      totalCost: 2,
    }));

    const { executeUnified } = await import("@/execution/unified-executor");
    const prd = makePrd([story1, story2]);
    const baseCtx = makeCtx({ parallelCount: 2 });
    const ctx = {
      ...baseCtx,
      config: {
        ...baseCtx.config,
        execution: { ...baseCtx.config.execution, costLimit: 100, maxIterations: 1 },
      },
    };

    await executeUnified(ctx, prd).catch(() => undefined);

    expect((ctx.statusWriter.setPrd as ReturnType<typeof mock>).mock.calls.length).toBeGreaterThanOrEqual(1);
    expect((ctx.statusWriter.setCurrentStory as ReturnType<typeof mock>).mock.calls.length).toBeGreaterThanOrEqual(1);
    expect((ctx.statusWriter.update as ReturnType<typeof mock>).mock.calls.length).toBeGreaterThanOrEqual(1);
    // setCurrentStory must be cleared (null) once the batch settles.
    const setCurrentStoryCalls = (ctx.statusWriter.setCurrentStory as ReturnType<typeof mock>).mock.calls;
    expect(setCurrentStoryCalls[0]?.[0]).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BUG-7 — parallel batch dispatch has no pre-dispatch cost-limit gate
// (asymmetric with the single-story path, which gates BEFORE spending)
// ─────────────────────────────────────────────────────────────────────────────

describe("BUG-7 — pre-dispatch cost gate on the parallel batch path", () => {
  let deps: Record<string, unknown>;
  let origRunParallelBatch: unknown;
  let origSelectIndependentBatch: unknown;

  beforeEach(async () => {
    const mod = await import("@/execution/unified-executor");
    deps = (mod as Record<string, unknown>)._unifiedExecutorDeps as Record<string, unknown>;
    origRunParallelBatch = deps.runParallelBatch;
    origSelectIndependentBatch = deps.selectIndependentBatch;
  });

  afterEach(() => {
    if (deps) {
      deps.runParallelBatch = origRunParallelBatch;
      deps.selectIndependentBatch = origSelectIndependentBatch;
    }
    mock.restore();
  });

  test("does not dispatch the batch when current cost already exceeds the limit — runParallelBatch is never called", async () => {
    const story1 = makePendingStory("US-001");
    const story2 = makePendingStory("US-002");

    deps.selectIndependentBatch = mock(() => [story1, story2]);
    const runParallelBatchMock = mock(async () => ({
      completed: [story1, story2],
      failed: [],
      mergeConflicts: [],
      storyCosts: new Map<string, number>(),
      totalCost: 0,
    }));
    deps.runParallelBatch = runParallelBatchMock;

    const { executeUnified } = await import("@/execution/unified-executor");
    const prd = makePrd([story1, story2]);
    const baseCtx = makeCtx({ parallelCount: 2 });
    const ctx = {
      ...baseCtx,
      config: {
        ...baseCtx.config,
        execution: { ...baseCtx.config.execution, costLimit: 5, maxIterations: 1 },
      },
      runtime: {
        ...baseCtx.runtime,
        costAggregator: {
          ...baseCtx.runtime.costAggregator,
          snapshot: () => ({ ...baseCtx.runtime.costAggregator.snapshot(), totalCostUsd: 10 }),
        },
      },
    };

    const result = await executeUnified(ctx, prd);

    expect(result.exitReason).toBe("cost-limit");
    expect(runParallelBatchMock).not.toHaveBeenCalled();
  });

  test("dispatches the batch when current cost is below the limit — pre-gate passes through", async () => {
    const story1 = makePendingStory("US-001");
    const story2 = makePendingStory("US-002");

    deps.selectIndependentBatch = mock(() => [story1, story2]);
    const runParallelBatchMock = mock(async () => ({
      completed: [story1, story2],
      failed: [],
      mergeConflicts: [],
      storyCosts: new Map<string, number>([
        [story1.id, 1],
        [story2.id, 1],
      ]),
      totalCost: 2,
    }));
    deps.runParallelBatch = runParallelBatchMock;

    const { executeUnified } = await import("@/execution/unified-executor");
    const prd = makePrd([story1, story2]);
    const baseCtx = makeCtx({ parallelCount: 2 });
    const ctx = {
      ...baseCtx,
      config: {
        ...baseCtx.config,
        execution: { ...baseCtx.config.execution, costLimit: 5, maxIterations: 1 },
      },
      runtime: {
        ...baseCtx.runtime,
        costAggregator: {
          ...baseCtx.runtime.costAggregator,
          snapshot: () => ({ ...baseCtx.runtime.costAggregator.snapshot(), totalCostUsd: 3 }),
        },
      },
    };

    const result = await executeUnified(ctx, prd).catch(() => ({ exitReason: "error" }) as { exitReason: string });

    expect(result.exitReason).not.toBe("cost-limit");
    expect(runParallelBatchMock).toHaveBeenCalled();
  });
});
