/**
 * US-003: Enforce per-tier attempt budgets before dispatch — executor wiring.
 *
 * Acceptance criteria for the unified-executor side of the budget feature:
 *
 *   AC-9:  When the sequential executor dispatches a selected story, it invokes
 *         preIterationTierCheck once with that story BEFORE it invokes runIteration.
 *   AC-10: When the sequential executor receives shouldSkipIteration: true from
 *         preIterationTierCheck, it does NOT invoke runIteration for that story.
 *
 * The AC-11 batch-executor cases are gone with the parallel dispatch path (US-001).
 *
 * The executor seam is `_unifiedExecutorDeps.preIterationTierCheck` — the
 * implementer is expected to wire it up in the same place where
 * `_unifiedExecutorDeps.runIteration` is called, so tests can stub it without
 * `mock.module()`. Currently the deps object does not carry that key, so the
 * call from the source is impossible → tests fail with assertion failures, not
 * compile errors.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import {
  cleanupTempDir,
  makeDispatchContext,
  makeMockRuntime,
  makePluginRegistry,
  makeStatusWriter,
  makeTempDir,
} from "@test/helpers";
import { DEFAULT_CONFIG } from "@/config";
import { stopHeartbeat } from "@/execution/crash-recovery";
import type { SequentialExecutionContext } from "@/execution/unified-executor";
import { executeUnified } from "@/execution/unified-executor";
import type { LoadedHooksConfig } from "@/hooks";
import type { PRD, UserStory } from "@/prd/types";
import { createNoOpCostAggregator } from "@/runtime/cost-aggregator";

let workdir: string;
beforeEach(() => {
  workdir = makeTempDir("nax-tier-budget-");
});

const EMPTY_HOOKS: LoadedHooksConfig = { hooks: {} };

// executeUnified starts a heartbeat that runner.ts normally owns; stop it here
// so the unit suite does not leak parked 60s-timer loops (#1679).
afterEach(() => {
  stopHeartbeat();
  cleanupTempDir(workdir);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test fixture helpers
// ─────────────────────────────────────────────────────────────────────────────

function makePendingStory(id: string, overrides: Record<string, unknown> = {}): UserStory {
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
    priorFailures: [],
    escalations: [],
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    ...overrides,
  };
}

function makePrd(stories: ReturnType<typeof makePendingStory>[]): PRD {
  const ts = new Date().toISOString();
  return {
    project: "test-project",
    feature: "test-feature",
    branchName: "test-branch",
    createdAt: ts,
    updatedAt: ts,
    userStories: stories,
  };
}

function makeCtx(overrides: { parallelCount?: number } = {}): SequentialExecutionContext {
  return {
    prdPath: join(workdir, "prd.json"),
    workdir,
    config: {
      ...DEFAULT_CONFIG,
      execution: {
        ...DEFAULT_CONFIG.execution,
        mode: "pipeline",
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
    runId: "run-tier-budget",
    startTime: Date.now(),
    batchPlan: [],
    interactionChain: null,
    ...makeDispatchContext({
      runtime: makeMockRuntime({
        workdir,
        costAggregator: createNoOpCostAggregator(),
      }),
    }),
    ...overrides,
  };
}

/** Read a key from `_unifiedExecutorDeps` without TypeScript complaining that
 *  the key isn't on the interface. Tests can both read and write through
 *  this view. */
function depsView() {
  // Cast through `unknown` to access arbitrary keys — same pattern as the
  // dispatch/logging test files. The actual field is added by the
  // implementer; until then the read returns `undefined` and the write
  // installs a stub the source never calls.
  return require("../../../src/execution/unified-executor") as {
    _unifiedExecutorDeps: Record<string, unknown>;
    executeUnified: typeof executeUnified;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AC-9: sequential executor invokes preIterationTierCheck once before runIteration
// ─────────────────────────────────────────────────────────────────────────────

describe("US-003 AC-9: sequential executor invokes preIterationTierCheck once before runIteration", () => {
  let origPreIterationTierCheck: unknown;
  let origRunIteration: unknown;

  beforeEach(() => {
    const deps = depsView()._unifiedExecutorDeps;
    origPreIterationTierCheck = deps.preIterationTierCheck;
    origRunIteration = deps.runIteration;
  });

  afterEach(() => {
    const deps = depsView()._unifiedExecutorDeps;
    deps.preIterationTierCheck = origPreIterationTierCheck;
    deps.runIteration = origRunIteration;
    mock.restore();
  });

  test("preIterationTierCheck is called exactly once with the selected story, BEFORE runIteration fires", async () => {
    const story = makePendingStory("US-001");

    const callOrder: string[] = [];
    const preIterationTierCheckMock = mock(async (s: ReturnType<typeof makePendingStory>) => {
      callOrder.push(`preIterationTierCheck:${s.id}`);
      return { shouldSkipIteration: false, prdDirty: false, prd: makePrd([s]) };
    });
    const runIterationMock = mock(
      async (_ctx: unknown, _prd: unknown, selection: { story: ReturnType<typeof makePendingStory> }) => {
        callOrder.push(`runIteration:${selection.story.id}`);
        return {
          prd: makePrd([]),
          storiesCompletedDelta: 1,
          costDelta: 0,
          prdDirty: false,
        };
      },
    );

    const deps = depsView()._unifiedExecutorDeps;
    deps.preIterationTierCheck = preIterationTierCheckMock;
    deps.runIteration = runIterationMock;

    const prd = makePrd([story]);
    const ctx = makeCtx({ parallelCount: undefined });

    await executeUnified(ctx, prd).catch(() => {});

    // AC-9: preIterationTierCheck is invoked exactly once with that story.
    expect(preIterationTierCheckMock).toHaveBeenCalledTimes(1);
    expect(preIterationTierCheckMock.mock.calls[0][0]?.id).toBe("US-001");

    // AC-9: preIterationTierCheck fires BEFORE runIteration.
    const preIdx = callOrder.findIndex((c) => c.startsWith("preIterationTierCheck:"));
    const runIdx = callOrder.findIndex((c) => c.startsWith("runIteration:"));
    expect(preIdx).toBeGreaterThanOrEqual(0);
    expect(runIdx).toBeGreaterThanOrEqual(0);
    expect(preIdx).toBeLessThan(runIdx);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-10: shouldSkipIteration=true → runIteration is NOT invoked
// ─────────────────────────────────────────────────────────────────────────────

describe("US-003 AC-10: sequential executor skips runIteration when shouldSkipIteration=true", () => {
  let origPreIterationTierCheck: unknown;
  let origRunIteration: unknown;

  beforeEach(() => {
    const deps = depsView()._unifiedExecutorDeps;
    origPreIterationTierCheck = deps.preIterationTierCheck;
    origRunIteration = deps.runIteration;
  });

  afterEach(() => {
    const deps = depsView()._unifiedExecutorDeps;
    deps.preIterationTierCheck = origPreIterationTierCheck;
    deps.runIteration = origRunIteration;
    mock.restore();
  });

  test("does not invoke runIteration when preIterationTierCheck returns shouldSkipIteration: true", async () => {
    const story = makePendingStory("US-001");

    const preIterationTierCheckMock = mock(async (s: ReturnType<typeof makePendingStory>) => {
      // Return skip; prdDirty=false so no loadPRD side-effect either.
      return { shouldSkipIteration: true, prdDirty: false, prd: makePrd([s]) };
    });
    const runIterationMock = mock(async () => {
      // Should never reach here on the AC-10 path.
      return {
        prd: makePrd([]),
        storiesCompletedDelta: 1,
        costDelta: 0,
        prdDirty: false,
      };
    });

    const deps = depsView()._unifiedExecutorDeps;
    deps.preIterationTierCheck = preIterationTierCheckMock;
    deps.runIteration = runIterationMock;

    const prd = makePrd([story]);
    const ctx = makeCtx({ parallelCount: undefined });

    await executeUnified(ctx, prd).catch(() => {});

    // AC-10: preIterationTierCheck was consulted.
    expect(preIterationTierCheckMock).toHaveBeenCalledTimes(1);
    // AC-10: runIteration was NOT invoked for that story.
    expect(runIterationMock).not.toHaveBeenCalled();
  });
});
