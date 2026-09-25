/**
 * runner.run() — workdir-aware run-id production (US-005)
 *
 * Two worktrees of one project can both produce `run-<iso>` IDs at the same
 * ISO timestamp and clobber each other's log file and status.json. The
 * runner therefore builds the run-id exactly once per run, using a stable
 * hash of the workdir so the two worktrees diverge even at the same
 * timestamp. A caller (resume, replay) can also supply a `runId` so the
 * resumed run reuses the same id — keeping the log file name and the run
 * record in sync.
 *
 * AC-7: run() uses a caller-supplied `runId` when one is given rather than
 *       generating another.
 * AC-8: run() invoked without a `runId` produces one through buildRunId,
 *       so two runs of one feature from different workdirs at the same
 *       timestamp receive different identifiers.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  makeMockRuntime,
  makeNaxConfig,
  makePluginRegistry,
  makePRD,
  makeSpawn,
  makeStatusWriter,
  makeStory,
} from "@test/helpers";
import { _runnerDeps, _runnerReentrancyGuard, _storyOrchestratorDeps, type RunOptions, run } from "@/execution";
import type { RunnerSetupResult } from "@/execution/runner-setup";
import type { PRD } from "@/prd";
import { SessionManager } from "@/session";
import { _gitDeps } from "@/utils/git";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCompletePrd(): PRD {
  return makePRD({
    feature: "test-feature",
    userStories: [
      makeStory({ id: "US-001", title: "Story 1", description: "Test story", status: "passed", passes: true }),
    ],
  });
}

function makeMinimalOptions(overrides: Partial<RunOptions> = {}): RunOptions {
  return {
    prdPath: "/tmp/nax-runner-runid/prd.json",
    workdir: "/tmp/nax-runner-runid",
    config: makeNaxConfig(),
    hooks: { hooks: {}, _skipGlobal: false },
    feature: "feat-x",
    featureDir: "/tmp/nax-runner-runid/.nax/features/feat-x",
    dryRun: false,
    useBatch: false,
    statusFile: "/tmp/nax-runner-runid/status.json",
    logFilePath: undefined,
    formatterMode: "quiet",
    headless: false,
    skipPrecheck: true,
    ...overrides,
  };
}

function makeSetupResult(prd: PRD): RunnerSetupResult & { sealApprovals: () => Promise<void> } {
  return {
    statusWriter: makeStatusWriter(),
    sessionManager: new SessionManager(),
    cleanupCrashHandlers: () => {},
    pluginRegistry: makePluginRegistry(),
    storyCounts: { total: 1, passed: 1, failed: 0, pending: 0 },
    interactionChain: null,
    prd,
    shutdownController: new AbortController(),
    runtime: makeMockRuntime(),
    // US-002: `sealApprovals` is required on RunnerSetupResult. Nothing in this
    // file seals, so a no-op stands in for the run-end approvals seal.
    sealApprovals: async () => {},
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let origLoad: typeof _storyOrchestratorDeps.loadCheckpoints;
let origRecordGreen: typeof _storyOrchestratorDeps.recordGreen;
let origGitSpawn: typeof _gitDeps.spawn;
let origRunnerDeps: typeof _runnerDeps;

beforeEach(() => {
  origLoad = _storyOrchestratorDeps.loadCheckpoints;
  origRecordGreen = _storyOrchestratorDeps.recordGreen;
  origGitSpawn = _gitDeps.spawn;
  origRunnerDeps = { ..._runnerDeps };
  _runnerReentrancyGuard.inFlight = false;
  _gitDeps.spawn = makeSpawn().spawn;
});

afterEach(() => {
  _storyOrchestratorDeps.loadCheckpoints = origLoad;
  _storyOrchestratorDeps.recordGreen = origRecordGreen;
  _gitDeps.spawn = origGitSpawn;
  Object.assign(_runnerDeps, origRunnerDeps);
  _runnerReentrancyGuard.inFlight = false;
  (mock as { restore?: () => void }).restore?.();
});

// ---------------------------------------------------------------------------
// AC-7 — caller-supplied runId is used verbatim
// ---------------------------------------------------------------------------

describe("runner.run() — US-005 AC-7 caller-supplied runId", () => {
  test("AC-7: passes the caller-supplied runId through to runSetupPhase without regenerating", async () => {
    const prd = makeCompletePrd();
    const suppliedRunId = "run-supplied-1234-abc";

    const seenRunIds: unknown[] = [];
    _runnerDeps.runSetupPhase = mock(async (opts) => {
      seenRunIds.push(opts.runId);
      return makeSetupResult(prd);
    }) as typeof _runnerDeps.runSetupPhase;
    _runnerDeps.runExecutionPhase = mock(async () => ({
      prd,
      iterations: 1,
      storiesCompleted: 1,
      totalCost: 0,
      allStoryMetrics: [],
      exitReason: "completed",
    })) as typeof _runnerDeps.runExecutionPhase;
    _runnerDeps.runCompletionPhase = mock(async () => ({
      durationMs: 1,
      runCompletedAt: new Date().toISOString(),
      acceptancePassed: true,
      pluginGateFailed: false,
      reportedTotal: 0,
    })) as typeof _runnerDeps.runCompletionPhase;

    await run(makeMinimalOptions({ runId: suppliedRunId }));

    expect(seenRunIds).toEqual([suppliedRunId]);
  });

  test("AC-7: a second run() call with a different supplied runId uses the new id, not the first", async () => {
    const prd = makeCompletePrd();
    const seenRunIds: string[] = [];

    _runnerDeps.runSetupPhase = mock(async (opts) => {
      seenRunIds.push(opts.runId as string);
      return makeSetupResult(prd);
    }) as typeof _runnerDeps.runSetupPhase;
    _runnerDeps.runExecutionPhase = mock(async () => ({
      prd,
      iterations: 1,
      storiesCompleted: 1,
      totalCost: 0,
      allStoryMetrics: [],
      exitReason: "completed",
    })) as typeof _runnerDeps.runExecutionPhase;
    _runnerDeps.runCompletionPhase = mock(async () => ({
      durationMs: 1,
      runCompletedAt: new Date().toISOString(),
      acceptancePassed: true,
      pluginGateFailed: false,
      reportedTotal: 0,
    })) as typeof _runnerDeps.runCompletionPhase;

    await run(makeMinimalOptions({ runId: "run-first-id" }));
    await run(makeMinimalOptions({ runId: "run-second-id" }));

    expect(seenRunIds).toEqual(["run-first-id", "run-second-id"]);
  });
});

// ---------------------------------------------------------------------------
// AC-8 — run() builds its runId through buildRunId when none is supplied
// ---------------------------------------------------------------------------

describe("runner.run() — US-005 AC-8 auto-generated runId", () => {
  test("AC-8: when runId is omitted, runner generates one (no 'run-<iso>' format); setup sees the generated id", async () => {
    const prd = makeCompletePrd();

    let capturedSetupRunId: string | undefined;
    _runnerDeps.runSetupPhase = mock(async (opts) => {
      capturedSetupRunId = opts.runId as string;
      return makeSetupResult(prd);
    }) as typeof _runnerDeps.runSetupPhase;
    _runnerDeps.runExecutionPhase = mock(async () => ({
      prd,
      iterations: 1,
      storiesCompleted: 1,
      totalCost: 0,
      allStoryMetrics: [],
      exitReason: "completed",
    })) as typeof _runnerDeps.runExecutionPhase;
    _runnerDeps.runCompletionPhase = mock(async () => ({
      durationMs: 1,
      runCompletedAt: new Date().toISOString(),
      acceptancePassed: true,
      pluginGateFailed: false,
      reportedTotal: 0,
    })) as typeof _runnerDeps.runCompletionPhase;

    await run(makeMinimalOptions({ runId: undefined }));

    const generatedId = capturedSetupRunId ?? "";
    expect(generatedId).toBeTruthy();
    // The runner must NOT generate the legacy `run-<iso>` format — that is
    // exactly the format that two worktrees collide on.
    expect(generatedId).not.toMatch(/^run-\d{4}-\d{2}-\d{2}T/);
    // Filename-safe: no path separator.
    expect(generatedId).not.toContain("/");
    expect(generatedId).not.toContain("\\");
    // Character class: [A-Za-z0-9._-] only.
    expect(generatedId).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  test("AC-8: two run() calls without runId, with different workdirs, produce different generated runIds", async () => {
    // The runner must build a workdir-aware runId for each invocation so
    // two worktrees of one project at the same instant get distinct ids.
    // We exercise the production path (run() → buildRunId → setup phase)
    // rather than calling buildRunId directly — a direct call would still
    // pass if runner.run() ignored workdir or generated the same id twice.
    const prd = makeCompletePrd();
    const seenRunIds: string[] = [];

    _runnerDeps.runSetupPhase = mock(async (opts) => {
      seenRunIds.push(opts.runId as string);
      return makeSetupResult(prd);
    }) as typeof _runnerDeps.runSetupPhase;
    _runnerDeps.runExecutionPhase = mock(async () => ({
      prd,
      iterations: 1,
      storiesCompleted: 1,
      totalCost: 0,
      allStoryMetrics: [],
      exitReason: "completed",
    })) as typeof _runnerDeps.runExecutionPhase;
    _runnerDeps.runCompletionPhase = mock(async () => ({
      durationMs: 1,
      runCompletedAt: new Date().toISOString(),
      acceptancePassed: true,
      pluginGateFailed: false,
      reportedTotal: 0,
    })) as typeof _runnerDeps.runCompletionPhase;

    // Two distinct workdirs — different parent dirs, same basename. This
    // is exactly the worktree-of-one-project shape the feature exists to
    // distinguish.
    const workdirA = "/Users/william/worktrees/parent-a/repo";
    const workdirB = "/Users/william/worktrees/parent-b/repo";

    // Pin "now" to the same instant on both calls so the runner must
    // diverge on the workdir hash, not the timestamp. The runner reads
    // startTime from Date.now() at the top of run(); we can't freeze the
    // real clock in this test, but the workdir hash dominates the id —
    // even if the two calls straddle a millisecond boundary the workdir
    // component of buildRunId is what separates the two outputs.
    await run(makeMinimalOptions({ workdir: workdirA, runId: undefined }));
    await run(makeMinimalOptions({ workdir: workdirB, runId: undefined }));

    expect(seenRunIds).toHaveLength(2);
    const [idA, idB] = seenRunIds;
    expect(idA).toBeDefined();
    expect(idB).toBeDefined();
    // Critical assertion: two runs at the same instant from different
    // workdirs receive distinct identifiers — the property that keeps the
    // log file / status.json of two worktrees from clobbering each other.
    expect(idA).not.toBe(idB);

    // Stronger: the workdir hash component (the hex segment between
    // `run-` and the timestamp) must differ between the two ids. If the
    // runner were using only the timestamp (e.g. `run-<iso>`), the two
    // calls could still produce distinct ids merely because `Date.now()`
    // strayed a millisecond — which is a property buildRunId does NOT
    // guarantee. The hash component is what makes the divergence
    // workdir-driven, not clock-driven.
    const hashA = idA?.match(/^run-([0-9a-f]{8})-/) ?? null;
    const hashB = idB?.match(/^run-([0-9a-f]{8})-/) ?? null;
    expect(hashA).not.toBeNull();
    expect(hashB).not.toBeNull();
    expect(hashA?.[1]).not.toBe(hashB?.[1]);
  });
});
