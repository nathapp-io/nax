/**
 * runner.ts — carry the reconciled run total through the runner's return and
 * cleanup handoff (US-001).
 *
 * The cost-aggregator-reconciled total only ever reached the completion
 * phase's local `reportedTotal` — the runner returned the execution-phase
 * accumulator (`executionResult.totalCost`) and handed that same pre-rectified
 * total to `cleanupRun`, so the printed footer, every post-run plugin and
 * every reporter saw the pre-completion figure. These tests pin the handoff:
 * after the completion phase, the `totalCost` binding becomes the completion
 * phase's `reportedTotal`, and both the returned `RunResult.totalCost` and the
 * value `cleanupRun` receives read that same binding.
 *
 * AC3: execution accumulator 5.6995, snapshot total 5.8042 → returned totalCost 5.8042
 * AC4: returned totalCost equals the completion phase's reportedTotal when the two differ
 * AC7: equal accumulator/snapshot → returned totalCost is that shared value
 * AC8: empty snapshot (reportedTotal 0) → returned totalCost is 0
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  assertDefined,
  makeMockRuntime,
  makeNaxConfig,
  makePluginRegistry,
  makePRD,
  makeSpawn,
  makeStatusWriter,
  makeStory,
} from "@test/helpers";
import {
  _runnerDeps,
  _runnerReentrancyGuard,
  _storyOrchestratorDeps,
  type RunCleanupOptions,
  type RunnerCompletionOptions,
  type RunOptions,
  run,
} from "@/execution";
import type { RunnerSetupResult } from "@/execution/runner-setup";
import { InteractionChain } from "@/interaction";
import type { PRD } from "@/prd";
import { SessionManager } from "@/session";
import { _gitDeps } from "@/utils/git";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EXECUTION_ACCUMULATOR = 5.6995;
const RECONCILED_TOTAL = 5.8042;

// ---------------------------------------------------------------------------
// Helpers
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
    prdPath: "/tmp/nax-runner-total/prd.json",
    workdir: "/tmp/nax-runner-total",
    // Real config/hooks — run() only forwards them to the (mocked) phases, and
    // no cast keeps the loose-cast ratchet clean.
    config: makeNaxConfig(),
    hooks: { hooks: {}, _skipGlobal: false },
    feature: "feat-x",
    featureDir: "/tmp/nax-runner-total/.nax/features/feat-x",
    dryRun: false,
    useBatch: false,
    statusFile: "/tmp/nax-runner-total/status.json",
    logFilePath: undefined,
    formatterMode: "quiet",
    headless: false,
    skipPrecheck: true,
    ...overrides,
  };
}

function makeSetupResult(prd: PRD): RunnerSetupResult {
  const runtime = makeMockRuntime();
  return {
    statusWriter: makeStatusWriter(),
    sessionManager: new SessionManager(),
    cleanupCrashHandlers: () => {},
    pluginRegistry: makePluginRegistry(),
    storyCounts: { total: 1, passed: 1, failed: 0, pending: 0 },
    interactionChain: null,
    prd,
    shutdownController: new AbortController(),
    runtime,
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
  // Hermetic: the finally block resolves the current branch via
  // gitWithTimeout — stub the git process it would spawn.
  _gitDeps.spawn = makeSpawn().spawn;
});

afterEach(() => {
  _storyOrchestratorDeps.loadCheckpoints = origLoad;
  _storyOrchestratorDeps.recordGreen = origRecordGreen;
  _gitDeps.spawn = origGitSpawn;
  // Restore the real phase functions — _runnerDeps is a process-wide singleton,
  // and leaving the mocks wired would contaminate every later test file's run().
  Object.assign(_runnerDeps, origRunnerDeps);
  // Safety net: a failing assertion mid-test must not leave the guard
  // stuck `true` and break every subsequent test's run() call.
  _runnerReentrancyGuard.inFlight = false;
  (mock as { restore?: () => void }).restore?.();
});

// ---------------------------------------------------------------------------
// AC3 / AC4 / AC7 / AC8 — run() handoff of the reconciled total
// ---------------------------------------------------------------------------

describe("runner.run() — US-001 reconciled-total handoff", () => {
  test("AC3: returns the reconciled total, not the pre-completion accumulator", async () => {
    const prd = makeCompletePrd();

    _runnerDeps.runSetupPhase = mock(async () => makeSetupResult(prd)) as typeof _runnerDeps.runSetupPhase;
    _runnerDeps.runExecutionPhase = mock(async () => ({
      prd,
      iterations: 1,
      storiesCompleted: 1,
      totalCost: EXECUTION_ACCUMULATOR,
      allStoryMetrics: [],
      exitReason: "completed",
    })) as typeof _runnerDeps.runExecutionPhase;
    _runnerDeps.runCompletionPhase = mock(async () => ({
      durationMs: 42,
      runCompletedAt: new Date().toISOString(),
      acceptancePassed: true,
      pluginGateFailed: false,
      reportedTotal: RECONCILED_TOTAL,
    })) as typeof _runnerDeps.runCompletionPhase;

    const result = await run(makeMinimalOptions());

    expect(result.success).toBe(true);
    expect(result.totalCost).toBeCloseTo(RECONCILED_TOTAL, 4);
    expect(result.totalCost).not.toBeCloseTo(EXECUTION_ACCUMULATOR, 4);
  });

  test("AC4: returned totalCost equals the completion phase's reportedTotal", async () => {
    const prd = makeCompletePrd();

    // completionPhase captures the reportedTotal it would produce; the runner
    // must surface exactly that figure regardless of the accumulator.
    let producedReportedTotal = 0;
    _runnerDeps.runSetupPhase = mock(async () => makeSetupResult(prd)) as typeof _runnerDeps.runSetupPhase;
    _runnerDeps.runExecutionPhase = mock(async () => ({
      prd,
      iterations: 1,
      storiesCompleted: 1,
      totalCost: EXECUTION_ACCUMULATOR,
      allStoryMetrics: [],
      exitReason: "completed",
    })) as typeof _runnerDeps.runExecutionPhase;
    _runnerDeps.runCompletionPhase = mock(async () => {
      producedReportedTotal = RECONCILED_TOTAL;
      return {
        durationMs: 42,
        runCompletedAt: new Date().toISOString(),
        acceptancePassed: true,
        pluginGateFailed: false,
        reportedTotal: RECONCILED_TOTAL,
      };
    }) as typeof _runnerDeps.runCompletionPhase;

    const result = await run(makeMinimalOptions());

    expect(producedReportedTotal).toBeCloseTo(RECONCILED_TOTAL, 4);
    expect(result.totalCost).toBeCloseTo(producedReportedTotal, 4);
  });

  test("AC7: equal accumulator and snapshot — the shared value is returned unchanged", async () => {
    const prd = makeCompletePrd();
    const shared = 6.21;

    _runnerDeps.runSetupPhase = mock(async () => makeSetupResult(prd)) as typeof _runnerDeps.runSetupPhase;
    _runnerDeps.runExecutionPhase = mock(async () => ({
      prd,
      iterations: 1,
      storiesCompleted: 1,
      totalCost: shared,
      allStoryMetrics: [],
      exitReason: "completed",
    })) as typeof _runnerDeps.runExecutionPhase;
    _runnerDeps.runCompletionPhase = mock(async () => ({
      durationMs: 42,
      runCompletedAt: new Date().toISOString(),
      acceptancePassed: true,
      pluginGateFailed: false,
      reportedTotal: shared,
    })) as typeof _runnerDeps.runCompletionPhase;

    const result = await run(makeMinimalOptions());

    expect(result.totalCost).toBeCloseTo(shared, 4);
  });

  test("AC8: empty snapshot reportedTotal 0 — returned totalCost is 0", async () => {
    const prd = makeCompletePrd();

    _runnerDeps.runSetupPhase = mock(async () => makeSetupResult(prd)) as typeof _runnerDeps.runSetupPhase;
    _runnerDeps.runExecutionPhase = mock(async () => ({
      prd,
      iterations: 1,
      storiesCompleted: 1,
      totalCost: EXECUTION_ACCUMULATOR,
      allStoryMetrics: [],
      exitReason: "completed",
    })) as typeof _runnerDeps.runExecutionPhase;
    _runnerDeps.runCompletionPhase = mock(async () => ({
      durationMs: 42,
      runCompletedAt: new Date().toISOString(),
      acceptancePassed: true,
      pluginGateFailed: false,
      reportedTotal: 0,
    })) as typeof _runnerDeps.runCompletionPhase;

    const result = await run(makeMinimalOptions());

    expect(result.totalCost).toBe(0);
  });

  test("AC3/AC5 handoff: cleanupRun receives the reconciled total", async () => {
    const prd = makeCompletePrd();

    _runnerDeps.runSetupPhase = mock(async () => makeSetupResult(prd)) as typeof _runnerDeps.runSetupPhase;
    _runnerDeps.runExecutionPhase = mock(async () => ({
      prd,
      iterations: 1,
      storiesCompleted: 1,
      totalCost: EXECUTION_ACCUMULATOR,
      allStoryMetrics: [],
      exitReason: "completed",
    })) as typeof _runnerDeps.runExecutionPhase;
    _runnerDeps.runCompletionPhase = mock(async () => ({
      durationMs: 42,
      runCompletedAt: new Date().toISOString(),
      acceptancePassed: true,
      pluginGateFailed: false,
      reportedTotal: RECONCILED_TOTAL,
    })) as typeof _runnerDeps.runCompletionPhase;

    let cleanupTotalCost: number | undefined;
    _runnerDeps.cleanupRun = mock(async (opts: RunCleanupOptions) => {
      cleanupTotalCost = opts.totalCost;
    }) as typeof _runnerDeps.cleanupRun;

    const result = await run(makeMinimalOptions());

    expect(result.totalCost).toBeCloseTo(RECONCILED_TOTAL, 4);
    expect(cleanupTotalCost).toBeCloseTo(RECONCILED_TOTAL, 4);
    expect(cleanupTotalCost).not.toBeCloseTo(EXECUTION_ACCUMULATOR, 4);
  });
});

// ---------------------------------------------------------------------------
// US-005 — run() forwards the interaction chain into the completion phase
// ---------------------------------------------------------------------------

describe("runner.run() — US-005 interaction-chain threading", () => {
  test("US-005 AC15: runCompletionPhase receives the setup phase's interaction chain by reference", async () => {
    const prd = makeCompletePrd();
    const chain = new InteractionChain({ defaultTimeout: 1000, defaultFallback: "abort" });

    _runnerDeps.runSetupPhase = mock(async () => ({
      ...makeSetupResult(prd),
      interactionChain: chain,
    })) as typeof _runnerDeps.runSetupPhase;
    _runnerDeps.runExecutionPhase = mock(async () => ({
      prd,
      iterations: 1,
      storiesCompleted: 1,
      totalCost: EXECUTION_ACCUMULATOR,
      allStoryMetrics: [],
      exitReason: "completed",
    })) as typeof _runnerDeps.runExecutionPhase;

    let seen: RunnerCompletionOptions | undefined;
    _runnerDeps.runCompletionPhase = mock(async (options: RunnerCompletionOptions) => {
      seen = options;
      return {
        durationMs: 42,
        runCompletedAt: new Date().toISOString(),
        acceptancePassed: true,
        pluginGateFailed: false,
        reportedTotal: RECONCILED_TOTAL,
      };
    }) as typeof _runnerDeps.runCompletionPhase;

    await run(makeMinimalOptions());

    assertDefined(seen, "runCompletionPhase options");
    expect(seen.interactionChain).toBe(chain);
  });
});
