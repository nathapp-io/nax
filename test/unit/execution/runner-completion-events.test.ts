/**
 * Tests for acceptance phase event details in runCompletionPhase (US-004)
 *
 * AC5: completed acceptance event details.retries equals acceptance-loop retry count
 * AC6: completed acceptance event details.failedACCount equals failed-criteria count
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { pipelineEventBus } from "@/pipeline";
import type { PostRunPhaseCompletedEvent } from "@/pipeline";
import {
  _runnerCompletionDeps,
  runCompletionPhase,
} from "@/execution";
import type { RunnerCompletionOptions } from "@/execution";
import type { AcceptanceLoopResult } from "@/execution/lifecycle/acceptance-loop";
import type { RunCompletionResult } from "@/execution/lifecycle/run-completion";
import type { NaxConfig } from "@/config";
import type { PRD, UserStory } from "@/prd";
import type { LoadedHooksConfig } from "@/hooks";
import { makeNaxConfig } from "@test/helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStory(id: string): UserStory {
  return {
    id,
    title: `Story ${id}`,
    description: "Test story",
    acceptanceCriteria: ["AC-1"],
    tags: [],
    dependencies: [],
    status: "passed",
    passes: true,
    escalations: [],
    attempts: 1,
  };
}

function makePRD(storyIds: string[]): PRD {
  return {
    project: "test-project",
    feature: "test-feature",
    branchName: "test-branch",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: storyIds.map(makeStory),
  };
}

function makeConfig(): NaxConfig {
  return makeNaxConfig({
    acceptance: { enabled: true, maxRetries: 3 },
    execution: { regressionGate: { mode: "disabled" } },
  });
}

function makeStatusWriter() {
  return {
    setPrd: mock(() => {}),
    setCurrentStory: mock(() => {}),
    setRunStatus: mock(() => {}),
    setPostRunPhase: mock((_phase: string, _update: Record<string, unknown>) => {}),
    update: mock(async () => {}),
    writeFeatureStatus: mock(async () => {}),
    // Return null so acceptance is not treated as already-passed
    getPostRunStatus: mock(() => null),
  };
}

const WORKDIR = `/tmp/nax-test-runner-completion-events-${randomUUID()}`;

function makeOpts(
  prd: PRD,
  statusWriter: ReturnType<typeof makeStatusWriter>,
  featureDir?: string,
): RunnerCompletionOptions {
  return {
    config: makeConfig(),
    hooks: { hooks: {}, _skipGlobal: false } as unknown as LoadedHooksConfig,
    feature: "test-feature",
    workdir: WORKDIR,
    statusFile: `${WORKDIR}/status.json`,
    logFilePath: undefined,
    runId: "run-001",
    startedAt: new Date().toISOString(),
    startTime: Date.now() - 1000,
    formatterMode: "quiet",
    headless: false,
    prd,
    allStoryMetrics: [],
    totalCost: 0,
    storiesCompleted: 1,
    iterations: 1,
    statusWriter: statusWriter as unknown as RunnerCompletionOptions["statusWriter"],
    pluginRegistry: {
      getAll: () => [],
      get: () => undefined,
    } as unknown as RunnerCompletionOptions["pluginRegistry"],
    prdPath: `${WORKDIR}/prd.json`,
    featureDir,
  };
}

const defaultCompletionResult: RunCompletionResult = {
  durationMs: 100,
  runCompletedAt: new Date().toISOString(),
  reportedTotal: 0,
  finalCounts: { total: 1, passed: 1, failed: 0, skipped: 0, pending: 0 },
  pluginGateFailed: false,
};

const origDeps = { ..._runnerCompletionDeps };

beforeEach(() => {
  _runnerCompletionDeps.handleRunCompletion = mock(async () => defaultCompletionResult);
  _runnerCompletionDeps.loadConfigForWorkdir = mock(async () => makeConfig());
  pipelineEventBus.clear();
});

afterEach(() => {
  Object.assign(_runnerCompletionDeps, origDeps);
  pipelineEventBus.clear();
  mock.restore();
});

// ---------------------------------------------------------------------------
// AC5: details.retries equals the acceptance-loop retry count
// ---------------------------------------------------------------------------

describe("runCompletionPhase — AC5: acceptance completed event details.retries", () => {
  test("AC5: details.retries equals retries returned from runAcceptanceLoop on success", async () => {
    const completed: PostRunPhaseCompletedEvent[] = [];
    pipelineEventBus.on("postrun:phase:completed", (e) => {
      if (e.phase === "acceptance") completed.push(e);
    });

    const prd = makePRD(["US-001"]);

    _runnerCompletionDeps.runAcceptanceLoop = mock(async (): Promise<AcceptanceLoopResult> => ({
      success: true,
      prd,
      totalCost: 0,
      iterations: 1,
      storiesCompleted: 1,
      prdDirty: false,
      retries: 2,
    }));

    await runCompletionPhase(makeOpts(prd, makeStatusWriter(), `${WORKDIR}/.nax/features/test-feature`));

    const event = completed.find((e) => e.phase === "acceptance");
    expect(event).toBeDefined();
    const details = event?.details as Record<string, unknown> | undefined;
    expect(details?.retries).toBe(2);
  });

  test("AC5: details.retries equals retries returned from runAcceptanceLoop on failure", async () => {
    const completed: PostRunPhaseCompletedEvent[] = [];
    pipelineEventBus.on("postrun:phase:completed", (e) => {
      if (e.phase === "acceptance") completed.push(e);
    });

    const prd = makePRD(["US-001"]);

    _runnerCompletionDeps.runAcceptanceLoop = mock(async (): Promise<AcceptanceLoopResult> => ({
      success: false,
      prd,
      totalCost: 0,
      iterations: 3,
      storiesCompleted: 1,
      prdDirty: false,
      retries: 3,
      failedACs: ["AC-1", "AC-2"],
    }));

    await runCompletionPhase(makeOpts(prd, makeStatusWriter(), `${WORKDIR}/.nax/features/test-feature`));

    const event = completed.find((e) => e.phase === "acceptance");
    expect(event).toBeDefined();
    const details = event?.details as Record<string, unknown> | undefined;
    expect(details?.retries).toBe(3);
  });

  test("AC5: details.retries is 0 when loop succeeds on first attempt", async () => {
    const completed: PostRunPhaseCompletedEvent[] = [];
    pipelineEventBus.on("postrun:phase:completed", (e) => {
      if (e.phase === "acceptance") completed.push(e);
    });

    const prd = makePRD(["US-001"]);

    _runnerCompletionDeps.runAcceptanceLoop = mock(async (): Promise<AcceptanceLoopResult> => ({
      success: true,
      prd,
      totalCost: 0,
      iterations: 1,
      storiesCompleted: 1,
      prdDirty: false,
      retries: 0,
    }));

    await runCompletionPhase(makeOpts(prd, makeStatusWriter(), `${WORKDIR}/.nax/features/test-feature`));

    const event = completed.find((e) => e.phase === "acceptance");
    const details = event?.details as Record<string, unknown> | undefined;
    expect(details?.retries).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC6: details.failedACCount equals the returned failed-criteria count
// ---------------------------------------------------------------------------

describe("runCompletionPhase — AC6: acceptance completed event details.failedACCount", () => {
  test("AC6: details.failedACCount equals failedACs.length when loop fails", async () => {
    const completed: PostRunPhaseCompletedEvent[] = [];
    pipelineEventBus.on("postrun:phase:completed", (e) => {
      if (e.phase === "acceptance") completed.push(e);
    });

    const prd = makePRD(["US-001"]);

    _runnerCompletionDeps.runAcceptanceLoop = mock(async (): Promise<AcceptanceLoopResult> => ({
      success: false,
      prd,
      totalCost: 0,
      iterations: 2,
      storiesCompleted: 1,
      prdDirty: false,
      retries: 2,
      failedACs: ["AC-1", "AC-2", "AC-3"],
    }));

    await runCompletionPhase(makeOpts(prd, makeStatusWriter(), `${WORKDIR}/.nax/features/test-feature`));

    const event = completed.find((e) => e.phase === "acceptance");
    expect(event).toBeDefined();
    const details = event?.details as Record<string, unknown> | undefined;
    expect(details?.failedACCount).toBe(3);
  });

  test("AC6: details.failedACCount is 0 when loop succeeds with no failing ACs", async () => {
    const completed: PostRunPhaseCompletedEvent[] = [];
    pipelineEventBus.on("postrun:phase:completed", (e) => {
      if (e.phase === "acceptance") completed.push(e);
    });

    const prd = makePRD(["US-001"]);

    _runnerCompletionDeps.runAcceptanceLoop = mock(async (): Promise<AcceptanceLoopResult> => ({
      success: true,
      prd,
      totalCost: 0,
      iterations: 1,
      storiesCompleted: 1,
      prdDirty: false,
      retries: 0,
      failedACs: [],
    }));

    await runCompletionPhase(makeOpts(prd, makeStatusWriter(), `${WORKDIR}/.nax/features/test-feature`));

    const event = completed.find((e) => e.phase === "acceptance");
    const details = event?.details as Record<string, unknown> | undefined;
    expect(details?.failedACCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC7: details.fixStoriesCreated equals the number of fix stories the
// acceptance loop created.
// ---------------------------------------------------------------------------

describe("runCompletionPhase — AC7: acceptance completed event details.fixStoriesCreated", () => {
  test("AC7: details.fixStoriesCreated is 0 when the acceptance loop succeeds", async () => {
    const completed: PostRunPhaseCompletedEvent[] = [];
    pipelineEventBus.on("postrun:phase:completed", (e) => {
      if (e.phase === "acceptance") completed.push(e);
    });

    const prd = makePRD(["US-001"]);

    _runnerCompletionDeps.runAcceptanceLoop = mock(async (): Promise<AcceptanceLoopResult> => ({
      success: true,
      prd,
      totalCost: 0,
      iterations: 1,
      storiesCompleted: 1,
      prdDirty: false,
      retries: 0,
    }));

    await runCompletionPhase(makeOpts(prd, makeStatusWriter(), `${WORKDIR}/.nax/features/test-feature`));

    const event = completed.find((e) => e.phase === "acceptance");
    expect(event).toBeDefined();
    const details = event?.details as Record<string, unknown> | undefined;
    expect(details?.fixStoriesCreated).toBe(0);
  });

  test("AC7: details.fixStoriesCreated is 0 when the acceptance loop fails (in-place rectification never appends fix stories)", async () => {
    const completed: PostRunPhaseCompletedEvent[] = [];
    pipelineEventBus.on("postrun:phase:completed", (e) => {
      if (e.phase === "acceptance") completed.push(e);
    });

    const prd = makePRD(["US-001"]);

    _runnerCompletionDeps.runAcceptanceLoop = mock(async (): Promise<AcceptanceLoopResult> => ({
      success: false,
      prd,
      totalCost: 0,
      iterations: 3,
      storiesCompleted: 1,
      prdDirty: false,
      retries: 3,
      failedACs: ["AC-1"],
    }));

    await runCompletionPhase(makeOpts(prd, makeStatusWriter(), `${WORKDIR}/.nax/features/test-feature`));

    const event = completed.find((e) => e.phase === "acceptance");
    expect(event).toBeDefined();
    const details = event?.details as Record<string, unknown> | undefined;
    expect(details?.fixStoriesCreated).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC11: the acceptance completed event carries durationMs measured from the
// matching postrun:phase:started event.
// ---------------------------------------------------------------------------

describe("runCompletionPhase — AC11: acceptance completed event durationMs", () => {
  test("AC11: details includes a non-negative durationMs on success", async () => {
    const completed: PostRunPhaseCompletedEvent[] = [];
    pipelineEventBus.on("postrun:phase:completed", (e) => {
      if (e.phase === "acceptance") completed.push(e);
    });

    const prd = makePRD(["US-001"]);
    _runnerCompletionDeps.runAcceptanceLoop = mock(async (): Promise<AcceptanceLoopResult> => ({
      success: true,
      prd,
      totalCost: 0,
      iterations: 1,
      storiesCompleted: 1,
      prdDirty: false,
      retries: 0,
    }));

    await runCompletionPhase(makeOpts(prd, makeStatusWriter(), `${WORKDIR}/.nax/features/test-feature`));

    const event = completed.find((e) => e.phase === "acceptance");
    expect(typeof event?.durationMs).toBe("number");
    expect(event?.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("AC11: details includes a non-negative durationMs on failure", async () => {
    const completed: PostRunPhaseCompletedEvent[] = [];
    pipelineEventBus.on("postrun:phase:completed", (e) => {
      if (e.phase === "acceptance") completed.push(e);
    });

    const prd = makePRD(["US-001"]);
    _runnerCompletionDeps.runAcceptanceLoop = mock(async (): Promise<AcceptanceLoopResult> => ({
      success: false,
      prd,
      totalCost: 0,
      iterations: 2,
      storiesCompleted: 1,
      prdDirty: false,
      retries: 2,
      failedACs: ["AC-1"],
    }));

    await runCompletionPhase(makeOpts(prd, makeStatusWriter(), `${WORKDIR}/.nax/features/test-feature`));

    const event = completed.find((e) => e.phase === "acceptance");
    expect(Number.isFinite(event?.durationMs)).toBe(true);
    expect(event?.durationMs).toBeGreaterThanOrEqual(0);
  });
});
