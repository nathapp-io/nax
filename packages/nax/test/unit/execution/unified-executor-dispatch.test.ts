/**
 * Unit tests for US-003: Unify executors — dispatch scheduling.
 *
 * File: unified-executor-dispatch.test.ts
 * Covers:
 *   useBatch scheduling refresh (batch plan recomputed after a story completes)
 *   BUG-39 retry priority over competing ready work
 *   US-001 AC-9 one story per iteration regardless of `parallelCount`
 *
 * The parallel-dispatch cases this file used to carry (AC-2, AC-4's parallel
 * arm, AC-5, AC-7 and BUG-3) are gone with the parallel dispatch path (US-001).
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
import { precomputeBatchPlan } from "@/execution/batching";
import { stopHeartbeat } from "@/execution/crash-recovery";
import type { StorySelection } from "@/execution/story-selector";
import type { SequentialExecutionContext } from "@/execution/unified-executor";
import { _unifiedExecutorDeps, executeUnified } from "@/execution/unified-executor";
import type { LoadedHooksConfig } from "@/hooks";
import type { EscalationAttempt, PRD, UserStory } from "@/prd/types";

const EMPTY_HOOKS: LoadedHooksConfig = { hooks: {} };

// executeUnified starts a heartbeat that runner.ts normally owns; stop it here
// so the unit suite does not leak parked 60s-timer loops (#1679).
afterEach(() => {
  stopHeartbeat();
});

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
    escalations,
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

// The fixture's prdPath/workdir: a real dir per test under `$TMPDIR`, because the
// executor persists the PRD at `prdPath` (`savePRD` writes `<path>.tmp-<uuid>`),
// and a confined run may not write a literal `/tmp/...`.
let fixtureDir: string;

beforeEach(() => {
  fixtureDir = makeTempDir("nax-unified-executor-dispatch-");
});

afterEach(() => {
  cleanupTempDir(fixtureDir);
});

function makeCtx(overrides: { parallelCount?: number; dryRun?: boolean } = {}): SequentialExecutionContext {
  return {
    prdPath: join(fixtureDir, "prd.json"),
    workdir: fixtureDir,
    config: {
      ...DEFAULT_CONFIG,
      execution: {
        ...DEFAULT_CONFIG.execution,
        mode: "pipeline",
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
    ...makeDispatchContext({ runtime: makeMockRuntime({ workdir: "/tmp/nax-test-dispatch-output" }) }),
    ...overrides,
  };
}

describe("useBatch scheduling refresh", () => {
  let deps: Record<string, unknown>;
  let origRunIteration: unknown;
  let origPreIterationTierCheck: unknown;

  beforeEach(async () => {
    const mod = await import("@/execution/unified-executor");
    deps = (mod as Record<string, unknown>)._unifiedExecutorDeps as Record<string, unknown>;
    origRunIteration = deps.runIteration;
    origPreIterationTierCheck = deps.preIterationTierCheck;
  });

  afterEach(() => {
    if (deps) {
      deps.runIteration = origRunIteration;
      deps.preIterationTierCheck = origPreIterationTierCheck;
    }
    mock.restore();
  });

  test("recomputes the batch plan after a story completes so newly unblocked stories run next", async () => {
    const us000: UserStory = {
      ...makePendingStory("US-000"),
      routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "simple" },
    };
    const us001: UserStory = {
      ...makePendingStory("US-001"),
      dependencies: ["US-000"],
      routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "simple" },
    };
    const us006: UserStory = {
      ...makePendingStory("US-006"),
      routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "simple" },
    };

    const initialPrd = makePrd([us000, us001, us006]);
    const staleBatchPlan = precomputeBatchPlan([us000, us006], 4);
    const selectedStoryIds: string[] = [];

    deps.runIteration = mock(async (_ctx: unknown, prdArg: typeof initialPrd, selection: { story: { id: string } }) => {
      selectedStoryIds.push(selection.story.id);
      const nextPrd = {
        ...prdArg,
        userStories: prdArg.userStories.map((story) =>
          story.id === selection.story.id ? { ...story, status: "passed" as const, passes: true } : story,
        ),
      };
      return {
        prd: nextPrd,
        storiesCompletedDelta: 1,
        costDelta: 0,
        prdDirty: false,
      };
    });

    const { executeUnified } = await import("@/execution/unified-executor");
    const ctx = {
      ...makeCtx(),
      config: {
        ...makeCtx().config,
        execution: {
          ...makeCtx().config.execution,
          maxIterations: 2,
        },
      },
      useBatch: true,
      batchPlan: staleBatchPlan,
    };

    await executeUnified(ctx, initialPrd);

    expect(selectedStoryIds).toEqual(["US-000", "US-001", "US-006"]);
  });

  test("BUG-39: a transiently failed story is retried before other ready work, under useBatch:true", async () => {
    // Before the underlying fix, two separate gaps combined to make a
    // transient failure terminal under useBatch:true:
    //  1. lastStoryId was only ever set when !ctx.useBatch, so getNextStory's
    //     retry-priority branch never even had a candidate to check.
    //  2. Even with lastStoryId correctly tracked, selectNextStories's
    //     batch-plan branch only consulted it via the single-story fallback
    //     (reached when the current batch slot is empty) — with another ready
    //     story competing (US-001 here), the batch-plan branch would just
    //     pick that other story every time, never retrying US-000.
    // This test needs a second, unrelated, always-ready story so the batch
    // plan is never empty after US-000 fails — proving the fix wins retry
    // priority over competing work, not just over an empty batch plan.
    const us000: UserStory = {
      ...makePendingStory("US-000"),
      routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "simple" },
    };
    const us001: UserStory = {
      ...makePendingStory("US-001"),
      routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "simple" },
    };
    const initialPrd = makePrd([us000, us001]);
    const selectedStoryIds: string[] = [];
    const callsPerStory: Record<string, number> = {};

    deps.runIteration = mock(async (_ctx: unknown, prdArg: typeof initialPrd, selection: { story: { id: string } }) => {
      selectedStoryIds.push(selection.story.id);
      callsPerStory[selection.story.id] = (callsPerStory[selection.story.id] ?? 0) + 1;
      // US-000 fails on its first dispatch, then passes on retry. US-001
      // always passes on its first (only) dispatch.
      const failsThisCall = selection.story.id === "US-000" && callsPerStory[selection.story.id] === 1;
      const nextPrd = {
        ...prdArg,
        userStories: prdArg.userStories.map((story) =>
          story.id === selection.story.id
            ? failsThisCall
              ? { ...story, status: "failed" as const, attempts: story.attempts + 1 }
              : { ...story, status: "passed" as const, passes: true }
            : story,
        ),
      };
      return {
        prd: nextPrd,
        storiesCompletedDelta: failsThisCall ? 0 : 1,
        costDelta: 0,
        prdDirty: false,
      };
    });

    const { executeUnified } = await import("@/execution/unified-executor");
    const baseCtx = makeCtx();
    const ctx = {
      ...baseCtx,
      config: {
        ...baseCtx.config,
        execution: { ...baseCtx.config.execution, maxIterations: 3 },
      },
      useBatch: true,
      batchPlan: precomputeBatchPlan([us000, us001], 4),
    };

    await executeUnified(ctx, initialPrd);

    // US-000 retried immediately after failing — before US-001 ever runs.
    expect(selectedStoryIds).toEqual(["US-000", "US-000", "US-001"]);
  });

  test("BUG-39: a story that exhausts its tier ladder stops winning retry priority (no starvation)", async () => {
    // A first pass at this fix retried lastStoryId unconditionally whenever it
    // was still resumable per getNextStory — but preIterationTierCheck (real,
    // unmocked in production) marks a tier-exhausted story permanently
    // "failed" via markStoryFailed, which getNextStory's own retry check also
    // treats as resumable (status "failed", attempts <= maxAttemptsTotal).
    // Without clearing lastStoryId once a story goes terminal, retry-priority
    // would keep re-selecting it every iteration — preIterationTierCheck skips
    // it again every time, dispatching nothing and starving every other story
    // in the PRD until maxIterations/maxAttemptsTotal is exhausted.
    const us000: UserStory = {
      ...makePendingStory("US-000"),
      routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "simple" },
    };
    const us001: UserStory = {
      ...makePendingStory("US-001"),
      routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "simple" },
    };
    const initialPrd = makePrd([us000, us001]);
    const selectedStoryIds: string[] = [];
    let tierCheckCallsForUs000 = 0;

    // US-000 always fails its (mocked) dispatch; US-001 always passes. This
    // makes US-000 retry-eligible after its first attempt, so retry-priority
    // re-selects it — at which point the preIterationTierCheck mock below
    // simulates the tier ladder being exhausted on that second check.
    deps.runIteration = mock(async (_ctx: unknown, prdArg: typeof initialPrd, selection: { story: { id: string } }) => {
      selectedStoryIds.push(selection.story.id);
      const nextPrd = {
        ...prdArg,
        userStories: prdArg.userStories.map((story) =>
          story.id === selection.story.id
            ? story.id === "US-000"
              ? { ...story, status: "failed" as const, attempts: story.attempts + 1 }
              : { ...story, status: "passed" as const, passes: true }
            : story,
        ),
      };
      return {
        prd: nextPrd,
        storiesCompletedDelta: selection.story.id === "US-000" ? 0 : 1,
        costDelta: 0,
        prdDirty: false,
      };
    });

    deps.preIterationTierCheck = mock(
      async (story: { id: string }, _routing: unknown, _config: unknown, prd: typeof initialPrd) => {
        if (story.id !== "US-000") {
          return { shouldSkipIteration: false, prdDirty: false, prd };
        }
        tierCheckCallsForUs000++;
        // First check (before US-000 has failed yet): still has budget, proceed.
        if (tierCheckCallsForUs000 === 1) {
          return { shouldSkipIteration: false, prdDirty: false, prd };
        }
        // Second check (the retry attempt, after US-000 already failed once):
        // tier ladder exhausted — markStoryFailed's real effect, status stays
        // "failed" and the run must move on instead of retrying forever.
        // prdDirty:false (unlike production, which saves to real disk and
        // reloads) — prd already carries the failed status from the runIteration
        // mock above, so no reload is needed here. Exhaust its retry budget too,
        // rather than relying on the removed fixed iteration cap.
        return {
          shouldSkipIteration: true,
          prdDirty: false,
          prd: { ...prd, userStories: prd.userStories.map((s) => (s.id === "US-000" ? { ...s, attempts: 99 } : s)) },
        };
      },
    );

    const { executeUnified } = await import("@/execution/unified-executor");
    const baseCtx = makeCtx();
    const ctx = {
      ...baseCtx,
      config: {
        ...baseCtx.config,
        execution: { ...baseCtx.config.execution, maxIterations: 3 },
      },
      useBatch: true,
      batchPlan: precomputeBatchPlan([us000, us001], 4),
    };

    await executeUnified(ctx, initialPrd);

    // US-000 dispatched once (fails), retried once more (goes terminal via
    // preIterationTierCheck, never reaching runIteration again) — US-001 must
    // still get a turn instead of the run spinning on US-000 until maxIterations.
    expect(selectedStoryIds).toEqual(["US-000", "US-001"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-001 AC-9 — parallelCount no longer selects the dispatch shape
// ─────────────────────────────────────────────────────────────────────────────

describe("US-001 AC-9 — a context with parallelCount 2 still dispatches one story per iteration", () => {
  const originalDeps = { ..._unifiedExecutorDeps };

  afterEach(() => {
    Object.assign(_unifiedExecutorDeps, originalDeps);
    mock.restore();
  });

  test("runIteration receives a selection holding exactly one story", async () => {
    const story1 = makePendingStory("US-001");
    const story2 = makePendingStory("US-002");
    const selections: Array<{ storiesToExecute: UserStory[]; story: UserStory }> = [];

    _unifiedExecutorDeps.runWorkflowPreflight = async () => {};
    _unifiedExecutorDeps.runIteration = mock(
      async (_ctx: SequentialExecutionContext, prdArg: PRD, selection: StorySelection) => {
        selections.push(selection);
        return {
          prd: {
            ...prdArg,
            userStories: prdArg.userStories.map((s) =>
              s.id === selection.story.id ? { ...s, status: "passed" as const, passes: true } : s,
            ),
          },
          storiesCompletedDelta: 1,
          costDelta: 0,
          prdDirty: false,
        };
      },
    );

    await executeUnified(makeCtx({ parallelCount: 2 }), makePrd([story1, story2]));

    expect(selections.length).toBeGreaterThan(0);
    expect(selections[0]?.storiesToExecute).toHaveLength(1);
    expect(selections[0]?.storiesToExecute[0]?.id).toBe("US-001");
  });
});
