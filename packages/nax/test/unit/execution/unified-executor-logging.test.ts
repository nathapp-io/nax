/**
 * Unit tests for US-003: Unify executors — story.start logging
 *
 * File: unified-executor-logging.test.ts
 * Covers:
 *   story.start logging — sequential (single-story) dispatch
 *   story.start announcement — profile-assigned stories (#1575)
 *   story.start suppression when the tier ladder is exhausted (#1653)
 *   story.start storyNumber is the story's PRD ordinal (#1653)
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { makeDispatchContext, makeMockRuntime, makePluginRegistry, makeStatusWriter } from "@test/helpers";
import { DEFAULT_CONFIG } from "@/config";
import { stopHeartbeat } from "@/execution/crash-recovery";
import type { SequentialExecutionContext } from "@/execution/unified-executor";
import type { LoadedHooksConfig } from "@/hooks";
import type { Logger } from "@/logger";
import * as loggerModule from "@/logger";
import type { EscalationAttempt, PRD, StoryRouting, UserStory } from "@/prd/types";

const EMPTY_HOOKS: LoadedHooksConfig = { hooks: {} };

// executeUnified starts a heartbeat that runner.ts normally owns; stop it here
// so the unit suite does not leak parked 60s-timer loops (#1679).
afterEach(() => {
  stopHeartbeat();
});

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

function makePendingStory(id: string, routing?: StoryRouting): UserStory {
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
    ...(routing ? { routing } : {}),
  };
}

/**
 * A story assigned to a cross-agent profile, carrying a stale persisted tier —
 * the #1575 shape. It must be announced as pi@balanced, not as the run default
 * agent at the leftover "fast" tier.
 */
function makeProfileStory(id: string): UserStory {
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
function makePassedStory(id: string): UserStory {
  return { ...makePendingStory(id), status: "passed", passes: true };
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

function makeCtx(): SequentialExecutionContext {
  return {
    prdPath: "/tmp/test-prd.json",
    workdir: "/tmp/test-workdir",
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
    ...makeDispatchContext({ runtime: makeMockRuntime({ workdir: "/tmp/nax-test-logging-output" }) }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// story.start logging — sequential (single-story) dispatch
// ─────────────────────────────────────────────────────────────────────────────

describe("story.start logging — sequential (single-story) dispatch", () => {
  let deps: Record<string, unknown>;
  let origRunIteration: unknown;
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
  });

  afterEach(() => {
    if (deps) deps.runIteration = origRunIteration;
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

    deps.runIteration = mock(async () => ({
      prd: makePrd([]),
      storiesCompletedDelta: 1,
      costDelta: 0,
      prdDirty: false,
    }));

    const { executeUnified } = await import("@/execution/unified-executor");
    const prd = makePrd([story1]);

    await executeUnified(makeCtx(), prd).catch(() => {});

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

    deps.runIteration = mock(async () => ({
      prd: makePrd([]),
      storiesCompletedDelta: 1,
      costDelta: 0,
      prdDirty: false,
    }));

    const { executeUnified } = await import("@/execution/unified-executor");
    const prd = makePrd([story1]);

    await executeUnified(makeCtx(), prd).catch(() => {});

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
    installLoggerSpy();
  });

  afterEach(() => {
    if (deps) deps.runIteration = origRunIteration;
    loggerSpy?.mockRestore();
    mock.restore();
  });

  test("single-story dispatch announces the story's own agent and its profile tier", async () => {
    const story = makeProfileStory("US-001");

    deps.runIteration = mock(async () => ({
      prd: makePrd([]),
      storiesCompletedDelta: 1,
      costDelta: 0,
      prdDirty: false,
    }));

    await executeUnified(makeCtx(), makePrd([story])).catch(() => {});

    const call = infoCalls.find((c) => c.stage === "story.start" && c.data?.storyId === "US-001");
    expect(call?.data).toMatchObject({ agent: "pi", modelTier: "balanced" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #1653: story.start must not be logged for an attempt that never runs
// ─────────────────────────────────────────────────────────────────────────────

describe("story.start suppression when the tier ladder is exhausted (#1653)", () => {
  let deps: Record<string, unknown>;
  let origRunIteration: unknown;
  let origPreIterationTierCheck: unknown;
  let spy: ReturnType<typeof installStoryLogSpy>;

  beforeEach(async () => {
    const mod = await import("@/execution/unified-executor");
    deps = (mod as Record<string, unknown>)._unifiedExecutorDeps as Record<string, unknown>;
    origRunIteration = deps.runIteration;
    origPreIterationTierCheck = deps.preIterationTierCheck;
    spy = installStoryLogSpy();
  });

  afterEach(() => {
    if (deps) {
      deps.runIteration = origRunIteration;
      deps.preIterationTierCheck = origPreIterationTierCheck;
    }
    spy?.restore();
    mock.restore();
  });

  test("logs no story.start when the pre-iteration check skips the story", async () => {
    const story = makePendingStory("US-001");
    const prd = makePrd([story]);

    deps.preIterationTierCheck = mock(async () => ({ shouldSkipIteration: true, prdDirty: false, prd }));
    deps.runIteration = mock(async () => {
      throw new Error("runIteration must not be reached for a skipped story");
    });

    const { executeUnified } = await import("@/execution/unified-executor");
    await executeUnified(makeCtx(), prd).catch(() => {});

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
    await executeUnified(makeCtx(), prd).catch(() => {});

    const calls = spy.calls.filter((c) => c.stage === "story.start");
    expect(calls).toHaveLength(1);
    expect(calls[0].data?.storyId).toBe("US-001");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #1653: storyNumber is the story's PRD ordinal, not a progress counter
// ─────────────────────────────────────────────────────────────────────────────

describe("story.start storyNumber is the story's PRD ordinal (#1653)", () => {
  let deps: Record<string, unknown>;
  let origRunIteration: unknown;
  let origPreIterationTierCheck: unknown;
  let spy: ReturnType<typeof installStoryLogSpy>;

  beforeEach(async () => {
    const mod = await import("@/execution/unified-executor");
    deps = (mod as Record<string, unknown>)._unifiedExecutorDeps as Record<string, unknown>;
    origRunIteration = deps.runIteration;
    origPreIterationTierCheck = deps.preIterationTierCheck;
    spy = installStoryLogSpy();
  });

  afterEach(() => {
    if (deps) {
      deps.runIteration = origRunIteration;
      deps.preIterationTierCheck = origPreIterationTierCheck;
    }
    spy?.restore();
    mock.restore();
  });

  test("a story keeps its own ordinal regardless of how many siblings have finished", async () => {
    // US-001 and US-002 finished; US-003 is the third story in the PRD and must be
    // announced as 3/3. The old pending-count derivation (total - pending + 1)
    // reported 2 here, because it counted completed siblings rather than the
    // story's place.
    const first = makePassedStory("US-001");
    const done = makePassedStory("US-002");
    const story = makePendingStory("US-003");
    const prd = makePrd([first, done, story]);

    deps.preIterationTierCheck = mock(async () => ({ shouldSkipIteration: false, prdDirty: false, prd }));
    deps.runIteration = mock(async () => ({
      prd: makePrd([first, done]),
      storiesCompletedDelta: 1,
      costDelta: 0,
      prdDirty: false,
    }));

    const { executeUnified } = await import("@/execution/unified-executor");
    await executeUnified(makeCtx(), prd).catch(() => {});

    const call = spy.calls.find((c) => c.stage === "story.start" && c.data?.storyId === "US-003");
    expect(call?.data).toMatchObject({ storyNumber: 3, storyTotal: 3 });
  });

  test("the first story in the PRD stays number 1 after a later sibling has passed", async () => {
    // The old derivation counted US-002's completion against US-001 and announced
    // it as 2/2 even though it is the first story in the PRD.
    const story = makePendingStory("US-001");
    const done = makePassedStory("US-002");
    const prd = makePrd([story, done]);

    deps.preIterationTierCheck = mock(async () => ({ shouldSkipIteration: false, prdDirty: false, prd }));
    deps.runIteration = mock(async () => ({
      prd: makePrd([done]),
      storiesCompletedDelta: 1,
      costDelta: 0,
      prdDirty: false,
    }));

    const { executeUnified } = await import("@/execution/unified-executor");
    await executeUnified(makeCtx(), prd).catch(() => {});

    const call = spy.calls.find((c) => c.stage === "story.start" && c.data?.storyId === "US-001");
    expect(call?.data).toMatchObject({ storyNumber: 1, storyTotal: 2 });
  });
});
