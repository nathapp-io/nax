/**
 * Unit tests for US-003: Unify executors — story.start logging
 *
 * File: unified-executor-logging.test.ts
 * Covers:
 *   story.start logging — parallel batch dispatch
 *   story.start logging — sequential (single-story) dispatch
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "@/logger";
import * as loggerModule from "@/logger";

/** One `logger.info` call captured by `installStoryLogSpy`. */
interface CapturedLog {
  stage: string;
  message: string;
  data?: Record<string, unknown>;
}

/**
 * Install a `getSafeLogger` spy and return the array its `info` calls land in.
 * The mock is typed as `Partial<Logger>` so the narrowing cast is a plain
 * widening rather than a double cast.
 */
function installStoryLogSpy(): { calls: CapturedLog[]; restore: () => void } {
  const calls: CapturedLog[] = [];
  const logger: Partial<Logger> = {
    info: mock((stage: string, message: string, data?: Record<string, unknown>) => {
      calls.push({ stage, message, data });
    }),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
  };
  const spy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger as Logger);
  return { calls, restore: () => spy.mockRestore() };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test fixture helpers
// ─────────────────────────────────────────────────────────────────────────────

function makePendingStory(id: string, routing?: Record<string, unknown>) {
  return {
    id,
    title: `Story ${id}`,
    description: `Description for ${id}`,
    acceptanceCriteria: [],
    tags: [],
    dependencies: [],
    status: "pending" as const,
    passes: false,
    attempts: 0,
    escalations: [],
    priorFailures: [],
    ...(routing ? { routing } : {}),
  };
}

/**
 * A story assigned to a cross-agent profile, carrying a stale persisted tier —
 * the #1575 shape. It must be announced as pi@balanced, not as the run default
 * agent at the leftover "fast" tier.
 */
function makeProfileStory(id: string) {
  return makePendingStory(id, {
    complexity: "medium",
    testStrategy: "test-after",
    reasoning: "",
    modelTier: "fast",
    profileModelTier: "balanced",
    agent: "pi",
    agentProfileId: "pi-balanced",
  });
}

/** A story the run has already completed — `makePendingStory` pins status to "pending". */
function makePassedStory(id: string) {
  return { ...makePendingStory(id), status: "passed" as const, passes: true };
}

function makePrd(stories: Array<ReturnType<typeof makePendingStory> | ReturnType<typeof makePassedStory>>) {
  return {
    project: "test-project",
    feature: "test-feature",
    branchName: "test-branch",
    createdAt: new Date().toISOString(),
    userStories: stories,
  };
}

function makeCtx(overrides: { parallelCount?: number } = {}) {
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
      // complexityRouting is required by NaxConfigSchema; buildPreviewRouting resolves
      // the announced tier through it, so the fixture must carry the real bands.
      autoMode: {
        defaultAgent: "claude-code",
        complexityRouting: { simple: "fast", medium: "balanced", complex: "powerful", expert: "powerful" },
      },
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
    runtime: {
      outputDir: "/tmp/nax-test-logging-output",
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
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// story.start logging — parallel batch dispatch
// ─────────────────────────────────────────────────────────────────────────────

describe("story.start logging — parallel batch dispatch", () => {
  let deps: Record<string, unknown>;
  let origRunParallelBatch: unknown;
  let origSelectIndependentBatch: unknown;
  let loggerSpy: ReturnType<typeof spyOn>;

  interface LogCall {
    stage: string;
    message: string;
    data?: Record<string, unknown>;
  }

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
    loggerSpy?.mockRestore();
    mock.restore();
  });

  test("logger.info is called with stage 'story.start' for each story in a parallel batch", async () => {
    const story1 = makePendingStory("US-001");
    const story2 = makePendingStory("US-002");

    const infoCalls: LogCall[] = [];
    const logger: Partial<Logger> = {
      info: mock((stage: string, message: string, data?: Record<string, unknown>) => {
        infoCalls.push({ stage, message, data });
      }),
      warn: mock(() => {}),
      error: mock(() => {}),
      debug: mock(() => {}),
    };
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger as Logger);

    deps.selectIndependentBatch = mock(() => [story1, story2]);
    deps.runParallelBatch = mock(async () => ({
      completed: [story1, story2],
      failed: [],
      mergeConflicts: [],
      storyCosts: new Map([
        [story1.id, 0],
        [story2.id, 0],
      ]),
      totalCost: 0,
    }));

    const { executeUnified } = await import("@/execution/unified-executor");
    const prd = makePrd([story1, story2]);
    const ctx = makeCtx({ parallelCount: 2 });

    await executeUnified(ctx as never, prd as never).catch(() => {});

    const storyStartCalls = infoCalls.filter((c) => c.stage === "story.start");
    expect(storyStartCalls.length).toBeGreaterThanOrEqual(2);

    const ids = storyStartCalls.map((c) => c.data?.storyId);
    expect(ids).toContain("US-001");
    expect(ids).toContain("US-002");
  });

  test("story.start log data includes storyId, storyTitle, complexity, modelTier, attempt for batch stories", async () => {
    const story1 = makePendingStory("US-001");

    const infoCalls: LogCall[] = [];
    const logger: Partial<Logger> = {
      info: mock((stage: string, message: string, data?: Record<string, unknown>) => {
        infoCalls.push({ stage, message, data });
      }),
      warn: mock(() => {}),
      error: mock(() => {}),
      debug: mock(() => {}),
    };
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger as Logger);

    deps.selectIndependentBatch = mock(() => [story1, makePendingStory("US-002")]);
    deps.runParallelBatch = mock(async () => ({
      completed: [story1],
      failed: [],
      mergeConflicts: [],
      storyCosts: new Map([[story1.id, 0]]),
      totalCost: 0,
    }));

    const { executeUnified } = await import("@/execution/unified-executor");
    const prd = makePrd([story1, makePendingStory("US-002")]);
    const ctx = makeCtx({ parallelCount: 2 });

    await executeUnified(ctx as never, prd as never).catch(() => {});

    const call = infoCalls.find((c) => c.stage === "story.start" && c.data?.storyId === "US-001");
    expect(call).toBeDefined();
    expect(call?.data).toMatchObject({
      storyId: "US-001",
      storyTitle: "Story US-001",
      attempt: 1,
    });
    expect(call?.data).toHaveProperty("complexity");
    expect(call?.data).toHaveProperty("modelTier");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// story.start logging — sequential (single-story) dispatch
// ─────────────────────────────────────────────────────────────────────────────

describe("story.start logging — sequential (single-story) dispatch", () => {
  let deps: Record<string, unknown>;
  let origRunIteration: unknown;
  let origSelectIndependentBatch: unknown;
  let loggerSpy: ReturnType<typeof spyOn>;

  interface LogCall {
    stage: string;
    message: string;
    data?: Record<string, unknown>;
  }

  beforeEach(async () => {
    const mod = await import("@/execution/unified-executor");
    deps = (mod as Record<string, unknown>)._unifiedExecutorDeps as Record<string, unknown>;
    origRunIteration = deps.runIteration;
    origSelectIndependentBatch = deps.selectIndependentBatch;
  });

  afterEach(() => {
    if (deps) {
      deps.runIteration = origRunIteration;
      deps.selectIndependentBatch = origSelectIndependentBatch;
    }
    loggerSpy?.mockRestore();
    mock.restore();
  });

  test("logger.info is called with stage 'story.start' for a single-story sequential dispatch", async () => {
    const story1 = makePendingStory("US-001");

    const infoCalls: LogCall[] = [];
    const logger: Partial<Logger> = {
      info: mock((stage: string, message: string, data?: Record<string, unknown>) => {
        infoCalls.push({ stage, message, data });
      }),
      warn: mock(() => {}),
      error: mock(() => {}),
      debug: mock(() => {}),
    };
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger as Logger);

    deps.selectIndependentBatch = mock(() => [story1]);
    deps.runIteration = mock(async () => ({
      prd: makePrd([]),
      storiesCompletedDelta: 1,
      costDelta: 0,
      prdDirty: false,
    }));

    const { executeUnified } = await import("@/execution/unified-executor");
    const prd = makePrd([story1]);
    const ctx = makeCtx({ parallelCount: 2 });

    await executeUnified(ctx as never, prd as never).catch(() => {});

    const storyStartCalls = infoCalls.filter((c) => c.stage === "story.start");
    expect(storyStartCalls.length).toBeGreaterThanOrEqual(1);
    expect(storyStartCalls[0].data?.storyId).toBe("US-001");
  });

  test("story.start log data includes storyId, storyTitle, complexity, modelTier, attempt for sequential dispatch", async () => {
    const story1 = makePendingStory("US-001");

    const infoCalls: LogCall[] = [];
    const logger: Partial<Logger> = {
      info: mock((stage: string, message: string, data?: Record<string, unknown>) => {
        infoCalls.push({ stage, message, data });
      }),
      warn: mock(() => {}),
      error: mock(() => {}),
      debug: mock(() => {}),
    };
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger as Logger);

    deps.selectIndependentBatch = mock(() => [story1]);
    deps.runIteration = mock(async () => ({
      prd: makePrd([]),
      storiesCompletedDelta: 1,
      costDelta: 0,
      prdDirty: false,
    }));

    const { executeUnified } = await import("@/execution/unified-executor");
    const prd = makePrd([story1]);
    const ctx = makeCtx({ parallelCount: 2 });

    await executeUnified(ctx as never, prd as never).catch(() => {});

    const call = infoCalls.find((c) => c.stage === "story.start" && c.data?.storyId === "US-001");
    expect(call).toBeDefined();
    expect(call?.data).toMatchObject({
      storyId: "US-001",
      storyTitle: "Story US-001",
      attempt: 1,
    });
    expect(call?.data).toHaveProperty("complexity");
    expect(call?.data).toHaveProperty("modelTier");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// story.start announcement — agent and tier must match what will actually run
// ─────────────────────────────────────────────────────────────────────────────

describe("story.start announcement — profile-assigned stories (#1575)", () => {
  let deps: Record<string, unknown>;
  let origRunIteration: unknown;
  let origRunParallelBatch: unknown;
  let origSelectIndependentBatch: unknown;
  let loggerSpy: ReturnType<typeof spyOn>;
  let executeUnified: typeof import("@/execution/unified-executor").executeUnified;

  interface LogCall {
    stage: string;
    message: string;
    data?: Record<string, unknown>;
  }

  let infoCalls: LogCall[];

  function installLoggerSpy() {
    infoCalls = [];
    const logger: Partial<Logger> = {
      info: mock((stage: string, message: string, data?: Record<string, unknown>) => {
        infoCalls.push({ stage, message, data });
      }),
      warn: mock(() => {}),
      error: mock(() => {}),
      debug: mock(() => {}),
    };
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger as Logger);
  }

  beforeEach(async () => {
    // unified-executor is not re-exported from the execution barrel, so this
    // stays a direct module import; capture executeUnified here so each test
    // does not repeat it.
    const mod = await import("@/execution/unified-executor");
    deps = (mod as Record<string, unknown>)._unifiedExecutorDeps as Record<string, unknown>;
    executeUnified = mod.executeUnified;
    origRunIteration = deps.runIteration;
    origRunParallelBatch = deps.runParallelBatch;
    origSelectIndependentBatch = deps.selectIndependentBatch;
    installLoggerSpy();
  });

  afterEach(() => {
    if (deps) {
      deps.runIteration = origRunIteration;
      deps.runParallelBatch = origRunParallelBatch;
      deps.selectIndependentBatch = origSelectIndependentBatch;
    }
    loggerSpy?.mockRestore();
    mock.restore();
  });

  test("single-story dispatch announces the story's own agent and its profile tier", async () => {
    const story = makeProfileStory("US-001");

    deps.selectIndependentBatch = mock(() => [story]);
    deps.runIteration = mock(async () => ({
      prd: makePrd([]),
      storiesCompletedDelta: 1,
      costDelta: 0,
      prdDirty: false,
    }));

    await executeUnified(makeCtx({ parallelCount: 2 }) as never, makePrd([story]) as never).catch(() => {});

    const call = infoCalls.find((c) => c.stage === "story.start" && c.data?.storyId === "US-001");
    expect(call?.data).toMatchObject({ agent: "pi", modelTier: "balanced" });
  });

  test("parallel batch announces each story's own agent and tier", async () => {
    const profiled = makeProfileStory("US-001");
    const plain = makePendingStory("US-002");

    deps.selectIndependentBatch = mock(() => [profiled, plain]);
    deps.runParallelBatch = mock(async () => ({
      completed: [profiled, plain],
      failed: [],
      mergeConflicts: [],
      storyCosts: new Map([
        [profiled.id, 0],
        [plain.id, 0],
      ]),
      totalCost: 0,
    }));

    await executeUnified(makeCtx({ parallelCount: 2 }) as never, makePrd([profiled, plain]) as never).catch(() => {});

    const profiledCall = infoCalls.find((c) => c.stage === "story.start" && c.data?.storyId === "US-001");
    expect(profiledCall?.data).toMatchObject({ agent: "pi", modelTier: "balanced" });

    // A story with no profile still falls back to the run's default agent.
    const plainCall = infoCalls.find((c) => c.stage === "story.start" && c.data?.storyId === "US-002");
    expect(plainCall?.data?.agent).not.toBe("pi");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #1653: story.start must not be logged for an attempt that never runs
// ─────────────────────────────────────────────────────────────────────────────

describe("story.start suppression when the tier ladder is exhausted (#1653)", () => {
  let deps: Record<string, unknown>;
  let origRunIteration: unknown;
  let origSelectIndependentBatch: unknown;
  let origPreIterationTierCheck: unknown;
  let spy: ReturnType<typeof installStoryLogSpy>;

  beforeEach(async () => {
    const mod = await import("@/execution/unified-executor");
    deps = (mod as Record<string, unknown>)._unifiedExecutorDeps as Record<string, unknown>;
    origRunIteration = deps.runIteration;
    origSelectIndependentBatch = deps.selectIndependentBatch;
    origPreIterationTierCheck = deps.preIterationTierCheck;
    spy = installStoryLogSpy();
  });

  afterEach(() => {
    if (deps) {
      deps.runIteration = origRunIteration;
      deps.selectIndependentBatch = origSelectIndependentBatch;
      deps.preIterationTierCheck = origPreIterationTierCheck;
    }
    spy?.restore();
    mock.restore();
  });

  test("single-story dispatch logs no story.start when the pre-iteration check skips the story", async () => {
    const story = makePendingStory("US-001");
    const prd = makePrd([story]);

    deps.selectIndependentBatch = mock(() => [story]);
    deps.preIterationTierCheck = mock(async () => ({ shouldSkipIteration: true, prdDirty: false, prd }));
    deps.runIteration = mock(async () => {
      throw new Error("runIteration must not be reached for a skipped story");
    });

    const { executeUnified } = await import("@/execution/unified-executor");
    await executeUnified(makeCtx({ parallelCount: 2 }) as never, prd as never).catch(() => {});

    expect(spy.calls.filter((c) => c.stage === "story.start")).toHaveLength(0);
  });

  test("sequential dispatch logs no story.start when the pre-iteration check skips the story", async () => {
    const story = makePendingStory("US-001");
    const prd = makePrd([story]);

    // No parallelCount — dispatch falls through to the sequential path.
    deps.preIterationTierCheck = mock(async () => ({ shouldSkipIteration: true, prdDirty: false, prd }));
    deps.runIteration = mock(async () => {
      throw new Error("runIteration must not be reached for a skipped story");
    });

    const { executeUnified } = await import("@/execution/unified-executor");
    await executeUnified(makeCtx() as never, prd as never).catch(() => {});

    expect(spy.calls.filter((c) => c.stage === "story.start")).toHaveLength(0);
  });

  test("story.start is still logged when the pre-iteration check lets the story run", async () => {
    const story = makePendingStory("US-001");
    const prd = makePrd([story]);

    deps.preIterationTierCheck = mock(async () => ({ shouldSkipIteration: false, prdDirty: false, prd }));
    deps.runIteration = mock(async () => ({
      prd: makePrd([]),
      storiesCompletedDelta: 1,
      costDelta: 0,
      prdDirty: false,
    }));

    const { executeUnified } = await import("@/execution/unified-executor");
    await executeUnified(makeCtx() as never, prd as never).catch(() => {});

    const calls = spy.calls.filter((c) => c.stage === "story.start");
    expect(calls).toHaveLength(1);
    expect(calls[0].data?.storyId).toBe("US-001");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #1653: the parallel batch announces only the stories that survive the pre-check
// ─────────────────────────────────────────────────────────────────────────────

describe("story.start suppression in a parallel batch (#1653)", () => {
  let deps: Record<string, unknown>;
  let origRunParallelBatch: unknown;
  let origSelectIndependentBatch: unknown;
  let origPreIterationTierCheck: unknown;
  let spy: ReturnType<typeof installStoryLogSpy>;
  let prdPath: string;

  beforeEach(async () => {
    const mod = await import("@/execution/unified-executor");
    deps = (mod as Record<string, unknown>)._unifiedExecutorDeps as Record<string, unknown>;
    origRunParallelBatch = deps.runParallelBatch;
    origSelectIndependentBatch = deps.selectIndependentBatch;
    origPreIterationTierCheck = deps.preIterationTierCheck;
    spy = installStoryLogSpy();
  });

  afterEach(async () => {
    if (deps) {
      deps.runParallelBatch = origRunParallelBatch;
      deps.selectIndependentBatch = origSelectIndependentBatch;
      deps.preIterationTierCheck = origPreIterationTierCheck;
    }
    spy?.restore();
    mock.restore();
    if (prdPath) await rm(prdPath, { force: true });
  });

  test("a batch story refused by the pre-iteration check is never announced", async () => {
    const kept = makePendingStory("US-001");
    const refused = makePendingStory("US-002");
    const prd = makePrd([kept, refused]);

    // runBatchPreChecks reloads the PRD from disk whenever a story is skipped,
    // so the fixture needs a real file behind ctx.prdPath.
    prdPath = join(tmpdir(), `nax-1653-batch-${process.pid}.json`);
    await Bun.write(prdPath, JSON.stringify(prd));

    deps.selectIndependentBatch = mock(() => [kept, refused]);
    deps.preIterationTierCheck = mock(async (story: { id: string }) => ({
      shouldSkipIteration: story.id === "US-002",
      prdDirty: false,
      prd,
    }));
    deps.runParallelBatch = mock(async () => ({
      completed: [kept],
      failed: [],
      mergeConflicts: [],
      storyCosts: new Map([[kept.id, 0]]),
      totalCost: 0,
    }));

    const { executeUnified } = await import("@/execution/unified-executor");
    const ctx = { ...makeCtx({ parallelCount: 2 }), prdPath };
    await executeUnified(ctx as never, prd as never).catch(() => {});

    const announced = spy.calls.filter((c) => c.stage === "story.start").map((c) => c.data?.storyId);
    expect(announced).toEqual(["US-001"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #1653: storyNumber is the story's PRD ordinal, not a progress counter
// ─────────────────────────────────────────────────────────────────────────────

describe("story.start storyNumber is the story's PRD ordinal (#1653)", () => {
  let deps: Record<string, unknown>;
  let origRunIteration: unknown;
  let origSelectIndependentBatch: unknown;
  let origPreIterationTierCheck: unknown;
  let spy: ReturnType<typeof installStoryLogSpy>;

  beforeEach(async () => {
    const mod = await import("@/execution/unified-executor");
    deps = (mod as Record<string, unknown>)._unifiedExecutorDeps as Record<string, unknown>;
    origRunIteration = deps.runIteration;
    origSelectIndependentBatch = deps.selectIndependentBatch;
    origPreIterationTierCheck = deps.preIterationTierCheck;
    spy = installStoryLogSpy();
  });

  afterEach(() => {
    if (deps) {
      deps.runIteration = origRunIteration;
      deps.selectIndependentBatch = origSelectIndependentBatch;
      deps.preIterationTierCheck = origPreIterationTierCheck;
    }
    spy?.restore();
    mock.restore();
  });

  test("a story keeps its own ordinal regardless of how many siblings have finished", async () => {
    // US-002 finished; US-003 is the third story in the PRD and must be announced
    // as 3/3. The old pending-count derivation (total - pending + 1) reported 2
    // here, because it counted completed siblings rather than the story's place.
    const first = makePendingStory("US-001");
    const done = makePassedStory("US-002");
    const story = makePendingStory("US-003");
    const prd = makePrd([first, done, story]);

    deps.selectIndependentBatch = mock(() => [story]);
    deps.preIterationTierCheck = mock(async () => ({ shouldSkipIteration: false, prdDirty: false, prd }));
    deps.runIteration = mock(async () => ({
      prd: makePrd([first, done]),
      storiesCompletedDelta: 1,
      costDelta: 0,
      prdDirty: false,
    }));

    const { executeUnified } = await import("@/execution/unified-executor");
    await executeUnified(makeCtx({ parallelCount: 2 }) as never, prd as never).catch(() => {});

    const call = spy.calls.find((c) => c.stage === "story.start" && c.data?.storyId === "US-003");
    expect(call?.data).toMatchObject({ storyNumber: 3, storyTotal: 3 });
  });

  test("the first story in the PRD stays number 1 after a later sibling has passed", async () => {
    // The old derivation counted US-002's completion against US-001 and announced
    // it as 2/2 even though it is the first story in the PRD.
    const story = makePendingStory("US-001");
    const done = makePassedStory("US-002");
    const prd = makePrd([story, done]);

    deps.selectIndependentBatch = mock(() => [story]);
    deps.preIterationTierCheck = mock(async () => ({ shouldSkipIteration: false, prdDirty: false, prd }));
    deps.runIteration = mock(async () => ({
      prd: makePrd([done]),
      storiesCompletedDelta: 1,
      costDelta: 0,
      prdDirty: false,
    }));

    const { executeUnified } = await import("@/execution/unified-executor");
    await executeUnified(makeCtx({ parallelCount: 2 }) as never, prd as never).catch(() => {});

    const call = spy.calls.find((c) => c.stage === "story.start" && c.data?.storyId === "US-001");
    expect(call?.data).toMatchObject({ storyNumber: 1, storyTotal: 2 });
  });
});
