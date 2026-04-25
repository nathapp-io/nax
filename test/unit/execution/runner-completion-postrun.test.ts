/**
 * Tests for setPostRunPhase calls in runCompletionPhase (US-002)
 *
 * Verifies that runCompletionPhase instruments the acceptance phase with
 * setPostRunPhase() at each entry/exit boundary:
 *
 * AC1: calls setPostRunPhase("acceptance", { status: "running" }) before runAcceptanceLoop()
 * AC2: calls setPostRunPhase("acceptance", { status: "passed", lastRunAt }) when loop succeeds
 * AC3: calls setPostRunPhase("acceptance", { status: "failed", failedACs, retries, lastRunAt }) when loop fails
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { pipelineEventBus } from "../../../src/pipeline/event-bus";
import {
  _runnerCompletionDeps,
  runCompletionPhase,
  type RunnerCompletionOptions,
} from "../../../src/execution/runner-completion";
import type { AcceptanceLoopResult } from "../../../src/execution/lifecycle/acceptance-loop";
import type { RunCompletionResult } from "../../../src/execution/lifecycle/run-completion";
import type { NaxConfig } from "../../../src/config";
import type { PRD, UserStory } from "../../../src/prd";
import type { LoadedHooksConfig } from "../../../src/hooks";
import { makeNaxConfig } from "../../helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStory(id: string, status: UserStory["status"]): UserStory {
  return {
    id,
    title: `Story ${id}`,
    description: "Test story",
    acceptanceCriteria: ["AC-1"],
    tags: [],
    dependencies: [],
    status,
    passes: status === "passed",
    escalations: [],
    attempts: 1,
  };
}

function makePRD(stories: Array<{ id: string; status: UserStory["status"] }>): PRD {
  return {
    project: "test-project",
    feature: "test-feature",
    branchName: "test-branch",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: stories.map(({ id, status }) => makeStory(id, status)),
  };
}

function makeConfig(acceptanceEnabled = true): NaxConfig {
  return makeNaxConfig({
    acceptance: {
      enabled: acceptanceEnabled,
      maxRetries: 3,
    },
    execution: {
      regressionGate: { mode: "disabled" },
    },
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
  };
}

const WORKDIR = `/tmp/nax-test-runner-completion-postrun-${randomUUID()}`;

function makeOpts(
  config: NaxConfig,
  prd: PRD,
  statusWriter: ReturnType<typeof makeStatusWriter>,
): RunnerCompletionOptions {
  return {
    config,
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
    pluginRegistry: { getAll: () => [], get: () => undefined } as unknown as RunnerCompletionOptions["pluginRegistry"],
    prdPath: `${WORKDIR}/prd.json`,
  };
}

// Default mock for handleRunCompletion (no regression)
const defaultCompletionResult: RunCompletionResult = {
  durationMs: 100,
  runCompletedAt: new Date().toISOString(),
  finalCounts: { total: 1, passed: 1, failed: 0, skipped: 0, pending: 0 },
};

const origDeps = { ..._runnerCompletionDeps };

beforeEach(() => {
  _runnerCompletionDeps.handleRunCompletion = mock(async () => defaultCompletionResult);
});

afterEach(() => {
  Object.assign(_runnerCompletionDeps, origDeps);
  pipelineEventBus.clear();
  mock.restore();
});

// ---------------------------------------------------------------------------
// AC1: setPostRunPhase("acceptance", { status: "running" }) before runAcceptanceLoop()
// ---------------------------------------------------------------------------

describe("runCompletionPhase - AC1: sets acceptance running before runAcceptanceLoop()", () => {
  test("calls setPostRunPhase('acceptance', { status: 'running' }) before runAcceptanceLoop()", async () => {
    const callOrder: string[] = [];

    const statusWriter = makeStatusWriter();
    statusWriter.setPostRunPhase = mock((phase: string, update: { status: string }) => {
      if (phase === "acceptance") {
        callOrder.push(`setPostRunPhase-acceptance-${update.status}`);
      }
    });

    _runnerCompletionDeps.runAcceptanceLoop = mock(async (): Promise<AcceptanceLoopResult> => {
      callOrder.push("runAcceptanceLoop");
      return {
        success: true,
        prd: makePRD([{ id: "US-001", status: "passed" }]),
        totalCost: 0,
        iterations: 1,
        storiesCompleted: 1,
        prdDirty: false,
      };
    });

    const prd = makePRD([{ id: "US-001", status: "passed" }]);
    const config = makeConfig(true);

    await runCompletionPhase(makeOpts(config, prd, statusWriter));

    const runningIdx = callOrder.indexOf("setPostRunPhase-acceptance-running");
    const loopIdx = callOrder.indexOf("runAcceptanceLoop");

    expect(runningIdx).toBeGreaterThanOrEqual(0);
    expect(runningIdx).toBeLessThan(loopIdx);
  });

  test("does NOT call setPostRunPhase for acceptance when acceptance is disabled", async () => {
    const statusWriter = makeStatusWriter();

    // acceptance disabled — loop won't run
    const prd = makePRD([{ id: "US-001", status: "passed" }]);
    const config = makeConfig(false);

    await runCompletionPhase(makeOpts(config, prd, statusWriter));

    const acceptanceCalls = statusWriter.setPostRunPhase.mock.calls.filter(
      (c: unknown[]) => c[0] === "acceptance",
    );
    expect(acceptanceCalls.length).toBe(0);
  });

  test("does NOT call setPostRunPhase for acceptance when PRD is incomplete", async () => {
    const statusWriter = makeStatusWriter();

    // Not all stories passed — isComplete returns false
    const prd = makePRD([
      { id: "US-001", status: "passed" },
      { id: "US-002", status: "pending" },
    ]);
    const config = makeConfig(true);

    await runCompletionPhase(makeOpts(config, prd, statusWriter));

    const acceptanceCalls = statusWriter.setPostRunPhase.mock.calls.filter(
      (c: unknown[]) => c[0] === "acceptance",
    );
    expect(acceptanceCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC2: setPostRunPhase("acceptance", { status: "passed", lastRunAt }) on success
// ---------------------------------------------------------------------------

describe("runCompletionPhase - AC2: sets acceptance passed when loop succeeds", () => {
  test("calls setPostRunPhase('acceptance', { status: 'passed', lastRunAt }) when runAcceptanceLoop returns success=true", async () => {
    const acceptanceCalls: Array<Record<string, unknown>> = [];

    const statusWriter = makeStatusWriter();
    statusWriter.setPostRunPhase = mock((phase: string, update: Record<string, unknown>) => {
      if (phase === "acceptance") {
        acceptanceCalls.push(update);
      }
    });

    _runnerCompletionDeps.runAcceptanceLoop = mock(async (): Promise<AcceptanceLoopResult> => ({
      success: true,
      prd: makePRD([{ id: "US-001", status: "passed" }]),
      totalCost: 0,
      iterations: 1,
      storiesCompleted: 1,
      prdDirty: false,
    }));

    const prd = makePRD([{ id: "US-001", status: "passed" }]);
    const config = makeConfig(true);

    await runCompletionPhase(makeOpts(config, prd, statusWriter));

    const passedCall = acceptanceCalls.find((u) => u.status === "passed");
    expect(passedCall).toBeDefined();
    expect(typeof passedCall?.lastRunAt).toBe("string");
    // Must be valid ISO 8601
    expect(new Date(passedCall?.lastRunAt as string).toISOString()).toBe(passedCall?.lastRunAt);
  });

  test("setPostRunPhase called in order: running then passed on success", async () => {
    const callOrder: string[] = [];

    const statusWriter = makeStatusWriter();
    statusWriter.setPostRunPhase = mock((phase: string, update: { status: string }) => {
      if (phase === "acceptance") {
        callOrder.push(update.status);
      }
    });

    _runnerCompletionDeps.runAcceptanceLoop = mock(async (): Promise<AcceptanceLoopResult> => ({
      success: true,
      prd: makePRD([{ id: "US-001", status: "passed" }]),
      totalCost: 0,
      iterations: 1,
      storiesCompleted: 1,
      prdDirty: false,
    }));

    const prd = makePRD([{ id: "US-001", status: "passed" }]);
    const config = makeConfig(true);

    await runCompletionPhase(makeOpts(config, prd, statusWriter));

    expect(callOrder.indexOf("running")).toBeLessThan(callOrder.indexOf("passed"));
  });
});

// ---------------------------------------------------------------------------
// AC3: setPostRunPhase("acceptance", { status: "failed", failedACs, retries, lastRunAt }) on failure
// ---------------------------------------------------------------------------

describe("runCompletionPhase - AC3: sets acceptance failed when loop fails", () => {
  test("calls setPostRunPhase('acceptance', { status: 'failed', failedACs, retries, lastRunAt }) when runAcceptanceLoop returns success=false", async () => {
    const acceptanceCalls: Array<Record<string, unknown>> = [];

    const statusWriter = makeStatusWriter();
    statusWriter.setPostRunPhase = mock((phase: string, update: Record<string, unknown>) => {
      if (phase === "acceptance") {
        acceptanceCalls.push(update);
      }
    });

    _runnerCompletionDeps.runAcceptanceLoop = mock(async (): Promise<AcceptanceLoopResult> => ({
      success: false,
      prd: makePRD([{ id: "US-001", status: "passed" }]),
      totalCost: 0,
      iterations: 1,
      storiesCompleted: 1,
      prdDirty: false,
      failedACs: ["AC-1", "AC-2"],
      retries: 3,
    }));

    const prd = makePRD([{ id: "US-001", status: "passed" }]);
    const config = makeConfig(true);

    await runCompletionPhase(makeOpts(config, prd, statusWriter));

    const failedCall = acceptanceCalls.find((u) => u.status === "failed");
    expect(failedCall).toBeDefined();
    expect(typeof failedCall?.lastRunAt).toBe("string");
    expect(new Date(failedCall?.lastRunAt as string).toISOString()).toBe(failedCall?.lastRunAt);
  });

  test("failed call includes failedACs from runAcceptanceLoop result", async () => {
    const acceptanceCalls: Array<Record<string, unknown>> = [];

    const statusWriter = makeStatusWriter();
    statusWriter.setPostRunPhase = mock((phase: string, update: Record<string, unknown>) => {
      if (phase === "acceptance") {
        acceptanceCalls.push(update);
      }
    });

    _runnerCompletionDeps.runAcceptanceLoop = mock(async (): Promise<AcceptanceLoopResult> => ({
      success: false,
      prd: makePRD([{ id: "US-001", status: "passed" }]),
      totalCost: 0,
      iterations: 1,
      storiesCompleted: 1,
      prdDirty: false,
      failedACs: ["AC-3", "AC-5"],
      retries: 2,
    }));

    const prd = makePRD([{ id: "US-001", status: "passed" }]);
    const config = makeConfig(true);

    await runCompletionPhase(makeOpts(config, prd, statusWriter));

    const failedCall = acceptanceCalls.find((u) => u.status === "failed");
    expect(failedCall?.failedACs).toEqual(["AC-3", "AC-5"]);
  });

  test("failed call includes retries from runAcceptanceLoop result", async () => {
    const acceptanceCalls: Array<Record<string, unknown>> = [];

    const statusWriter = makeStatusWriter();
    statusWriter.setPostRunPhase = mock((phase: string, update: Record<string, unknown>) => {
      if (phase === "acceptance") {
        acceptanceCalls.push(update);
      }
    });

    _runnerCompletionDeps.runAcceptanceLoop = mock(async (): Promise<AcceptanceLoopResult> => ({
      success: false,
      prd: makePRD([{ id: "US-001", status: "passed" }]),
      totalCost: 0,
      iterations: 1,
      storiesCompleted: 1,
      prdDirty: false,
      failedACs: ["AC-1"],
      retries: 2,
    }));

    const prd = makePRD([{ id: "US-001", status: "passed" }]);
    const config = makeConfig(true);

    await runCompletionPhase(makeOpts(config, prd, statusWriter));

    const failedCall = acceptanceCalls.find((u) => u.status === "failed");
    expect(failedCall?.retries).toBe(2);
  });

  test("setPostRunPhase called in order: running then failed on failure", async () => {
    const callOrder: string[] = [];

    const statusWriter = makeStatusWriter();
    statusWriter.setPostRunPhase = mock((phase: string, update: { status: string }) => {
      if (phase === "acceptance") {
        callOrder.push(update.status);
      }
    });

    _runnerCompletionDeps.runAcceptanceLoop = mock(async (): Promise<AcceptanceLoopResult> => ({
      success: false,
      prd: makePRD([{ id: "US-001", status: "passed" }]),
      totalCost: 0,
      iterations: 1,
      storiesCompleted: 1,
      prdDirty: false,
      failedACs: ["AC-1"],
      retries: 1,
    }));

    const prd = makePRD([{ id: "US-001", status: "passed" }]);
    const config = makeConfig(true);

    await runCompletionPhase(makeOpts(config, prd, statusWriter));

    expect(callOrder.indexOf("running")).toBeLessThan(callOrder.indexOf("failed"));
  });
});

// ---------------------------------------------------------------------------
// Monorepo: acceptanceTestPaths derived from PRD story workdirs (bug fix)
// ---------------------------------------------------------------------------

describe("runCompletionPhase - monorepo: acceptanceTestPaths passed to runAcceptanceLoop", () => {
  test("passes acceptanceTestPaths derived from PRD workdirs when featureDir is set", async () => {
    let capturedCtx: Parameters<typeof _runnerCompletionDeps.runAcceptanceLoop>[0] | undefined;

    _runnerCompletionDeps.runAcceptanceLoop = mock(async (ctx): Promise<AcceptanceLoopResult> => {
      capturedCtx = ctx;
      return {
        success: true,
        prd: ctx.prd,
        totalCost: 0,
        iterations: 1,
        storiesCompleted: 2,
        prdDirty: false,
      };
    });

    const prd: PRD = {
      project: "proj",
      feature: "graphify-kb-cc",
      branchName: "feat/graphify-kb-cc",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userStories: [
        { ...makeStory("US-001", "passed"), workdir: "apps/api" },
        { ...makeStory("US-002", "passed"), workdir: "apps/cli" },
      ],
    };

    const config = makeConfig(true);
    const statusWriter = makeStatusWriter();
    const opts: RunnerCompletionOptions = {
      ...makeOpts(config, prd, statusWriter),
      featureDir: `${WORKDIR}/.nax/features/graphify-kb-cc`,
    };

    await runCompletionPhase(opts);

    const paths = capturedCtx?.acceptanceTestPaths ?? [];
    expect(paths.length).toBe(2);
    const packageDirs = paths.map((p) => p.packageDir).sort();
    expect(packageDirs).toEqual([`${WORKDIR}/apps/api`, `${WORKDIR}/apps/cli`]);
  });

  test("passes undefined acceptanceTestPaths when featureDir is not set", async () => {
    let capturedCtx: Parameters<typeof _runnerCompletionDeps.runAcceptanceLoop>[0] | undefined;

    _runnerCompletionDeps.runAcceptanceLoop = mock(async (ctx): Promise<AcceptanceLoopResult> => {
      capturedCtx = ctx;
      return {
        success: true,
        prd: ctx.prd,
        totalCost: 0,
        iterations: 1,
        storiesCompleted: 1,
        prdDirty: false,
      };
    });

    const prd = makePRD([{ id: "US-001", status: "passed" }]);
    const config = makeConfig(true);
    const statusWriter = makeStatusWriter();
    const opts: RunnerCompletionOptions = {
      ...makeOpts(config, prd, statusWriter),
      featureDir: undefined,
    };

    await runCompletionPhase(opts);

    expect(capturedCtx?.acceptanceTestPaths).toBeUndefined();
  });
});
