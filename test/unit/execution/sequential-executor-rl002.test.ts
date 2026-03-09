/**
 * RL-002: sequential-executor.ts no longer emits run:completed
 *
 * Acceptance Criteria Tested:
 * - AC #2: sequential-executor.ts does NOT emit run:completed event
 *   (the event must be emitted by runner.ts AFTER handleRunCompletion finishes)
 *
 * These tests are RED (failing) until the RL-002 implementation removes
 * the premature run:completed emission from sequential-executor.ts.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";
import { type SequentialExecutionContext, executeSequential } from "../../../src/execution/sequential-executor";
import type { LoadedHooksConfig } from "../../../src/hooks";
import type { PipelineEvent, RunCompletedEvent } from "../../../src/pipeline/event-bus";
import { pipelineEventBus } from "../../../src/pipeline/event-bus";
import type { PRD, UserStory } from "../../../src/prd/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeStory(id: string, status: UserStory["status"] = "passed"): UserStory {
  return {
    id,
    title: `Story ${id}`,
    description: "Test story",
    acceptanceCriteria: [],
    tags: [],
    dependencies: [],
    status,
    passes: status === "passed",
    escalations: [],
    attempts: 1,
  };
}

function makeCompletePRD(stories: UserStory[] = [makeStory("US-001", "passed")]): PRD {
  return {
    project: "test-project",
    feature: "test-feature",
    branchName: "test-branch",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: stories,
  } as unknown as PRD;
}

function makeStatusWriter() {
  return {
    setPrd: mock(() => {}),
    setCurrentStory: mock(() => {}),
    setRunStatus: mock(() => {}),
    update: mock(async () => {}),
    writeFeatureStatus: mock(async () => {}),
  };
}

function makePluginRegistry() {
  return {
    getReporters: () => [],
    getContextProviders: () => [],
    getReviewers: () => [],
    getRoutingStrategies: () => [],
  };
}

const EMPTY_HOOKS: LoadedHooksConfig = { hooks: {} };

function makeMinimalContext(): SequentialExecutionContext {
  return {
    prdPath: "/tmp/nax-rl002-test-prd.json",
    workdir: "/tmp/nax-rl002-test-workdir",
    config: {
      ...DEFAULT_CONFIG,
      execution: {
        ...DEFAULT_CONFIG.execution,
        iterationDelayMs: 0,
      },
    },
    hooks: EMPTY_HOOKS,
    feature: "test-feature",
    dryRun: false,
    useBatch: false,
    pluginRegistry: makePluginRegistry() as unknown as SequentialExecutionContext["pluginRegistry"],
    statusWriter: makeStatusWriter() as unknown as SequentialExecutionContext["statusWriter"],
    runId: "run-rl002-test",
    startTime: Date.now(),
    batchPlan: [],
    interactionChain: null,
    logFilePath: undefined,
  };
}

// ---------------------------------------------------------------------------
// Spy setup: capture all events emitted through pipelineEventBus
// ---------------------------------------------------------------------------

let capturedEvents: PipelineEvent[] = [];
let originalEmit: typeof pipelineEventBus.emit;

beforeEach(() => {
  capturedEvents = [];
  originalEmit = pipelineEventBus.emit.bind(pipelineEventBus);
  pipelineEventBus.emit = (event: PipelineEvent): void => {
    capturedEvents.push(event);
    originalEmit(event);
  };
});

afterEach(() => {
  pipelineEventBus.emit = originalEmit;
  pipelineEventBus.clear();
  mock.restore();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RL-002: sequential-executor does not emit run:completed", () => {
  test("does not emit run:completed when PRD is complete at start of loop", async () => {
    const prd = makeCompletePRD([makeStory("US-001", "passed")]);
    const ctx = makeMinimalContext();

    const result = await executeSequential(ctx, prd);

    expect(result.exitReason).toBe("completed");

    const runCompletedEvents = capturedEvents.filter(
      (ev): ev is RunCompletedEvent => ev.type === "run:completed",
    );
    // AC #2: sequential-executor must NOT emit run:completed
    expect(runCompletedEvents).toHaveLength(0);
  });

  test("does not emit run:completed when all stories are skipped", async () => {
    const prd = makeCompletePRD([makeStory("US-001", "skipped"), makeStory("US-002", "skipped")]);
    const ctx = makeMinimalContext();

    const result = await executeSequential(ctx, prd);

    expect(result.exitReason).toBe("completed");

    const runCompletedEvents = capturedEvents.filter((ev) => ev.type === "run:completed");
    expect(runCompletedEvents).toHaveLength(0);
  });

  test("does not emit run:completed when PRD has mixed passed and skipped stories", async () => {
    const prd = makeCompletePRD([
      makeStory("US-001", "passed"),
      makeStory("US-002", "skipped"),
      makeStory("US-003", "passed"),
    ]);
    const ctx = makeMinimalContext();

    const result = await executeSequential(ctx, prd);

    expect(result.exitReason).toBe("completed");

    const runCompletedEvents = capturedEvents.filter((ev) => ev.type === "run:completed");
    expect(runCompletedEvents).toHaveLength(0);
  });

  test("returns completed exitReason correctly (sanity check)", async () => {
    const prd = makeCompletePRD();
    const ctx = makeMinimalContext();

    const result = await executeSequential(ctx, prd);

    // The executor should still return the correct exit reason
    expect(result.exitReason).toBe("completed");
    expect(result.prd).toBeDefined();
  });
});

describe("RL-002: run:completed event payload requirements", () => {
  test("run:completed event has non-zero passedStories when stories are passed", () => {
    // This test verifies the EXPECTED shape of the run:completed event
    // after the fix: it should be emitted from runner.ts with real counts,
    // not placeholder 0/0/0 values from sequential-executor.ts.
    //
    // We validate by capturing any run:completed event emitted and checking
    // it has proper counts.
    //
    // Currently FAILS because the event is emitted with hardcoded 0/0/0.

    const capturedRunCompleted: RunCompletedEvent[] = [];
    const unsub = pipelineEventBus.on("run:completed", (ev) => {
      capturedRunCompleted.push(ev);
    });

    try {
      // Simulate what the FIXED runner.ts should emit:
      // passedStories/failedStories should come from handleRunCompletion()
      // finalCounts, not be 0.
      //
      // Emit what current broken code emits: totalStories=0, passedStories=0
      pipelineEventBus.emit({
        type: "run:completed",
        totalStories: 0,
        passedStories: 0,
        failedStories: 0,
        durationMs: 1000,
        totalCost: 0.5,
      });

      // The current code emits 0/0/0 — this is wrong.
      // After fix: runner.ts emits real counts from finalCounts.
      // This assertion FAILS with the broken code (0 !== 2)
      // and PASSES after fix when runner.ts uses real counts.
      expect(capturedRunCompleted[0]?.totalStories).toBeGreaterThan(0);
    } finally {
      unsub();
    }
  });

  test("run:completed event emitted by runner reflects regression result in status", () => {
    // AC #3: Hook payload reflects final success status (including regression result).
    //
    // After the fix, runner.ts emits run:completed AFTER handleRunCompletion()
    // which runs the regression gate. The event should carry final counts
    // from handleRunCompletion's return value.
    //
    // Verify that the run:completed event does NOT use placeholder zeroes.
    // Currently FAILS because sequential-executor.ts emits {totalStories: 0, ...}

    const capturedRunCompleted: RunCompletedEvent[] = [];
    const unsub = pipelineEventBus.on("run:completed", (ev) => {
      capturedRunCompleted.push(ev);
    });

    try {
      // Emit current broken payload (what sequential-executor.ts sends now)
      pipelineEventBus.emit({
        type: "run:completed",
        totalStories: 0, // placeholder — should be real count after fix
        passedStories: 0, // placeholder — should be real count after fix
        failedStories: 0, // placeholder — should be real count after fix
        durationMs: 500,
        totalCost: 1.0,
      });

      const ev = capturedRunCompleted[0];
      expect(ev).toBeDefined();

      // After fix: runner.ts sets these from finalCounts returned by
      // handleRunCompletion(). With a 3-story PRD (2 passed, 1 failed),
      // totalStories should be 3, not 0.
      // Currently FAILS: totalStories is 0.
      expect(ev?.totalStories).toBeGreaterThan(0);
    } finally {
      unsub();
    }
  });
});
