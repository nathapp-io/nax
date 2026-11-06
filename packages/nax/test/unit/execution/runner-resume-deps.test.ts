/**
 * runner.run() — resume-mode lifecycle regression tests.
 *
 * `run()` carries its resume mode into workflow resume (`_workflowResumeDeps.mode`)
 * and nothing else. The orchestrator's checkpoint deps
 * (`_storyOrchestratorDeps.loadCheckpoints` / `recordGreen`) are no longer
 * saved, wired or restored — the checkpoint store's reader and writer are gone,
 * so there is nothing to wire them to. These tests pin both halves:
 *
 *   - the workflow seam is set before the setup phase and restored on BOTH
 *     exits (the setup-error catch and the outer `finally`);
 *   - the orchestrator seam is left exactly as it was found.
 *
 * We stub `_runnerDeps.runSetupPhase` to throw without going through the full
 * setup pipeline (lock acquisition, crash handlers, etc.); the `finally` case
 * stubs the three phases so the run reaches its cleanup path.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  assertCaughtInstanceOf,
  makeMockRuntime,
  makePluginRegistry,
  makePRD,
  makeSpawn,
  makeStatusWriter,
  makeStory,
} from "@test/helpers";
import type { NaxConfig } from "@/config";
import { NaxError } from "@/errors";
import {
  _runnerDeps,
  _runnerReentrancyGuard,
  _storyOrchestratorDeps,
  _workflowResumeDeps,
  type ResumeMode,
  type RunOptions,
  run,
} from "@/execution";
import type { RunnerSetupResult } from "@/execution/runner-setup";
import type { LoadedHooksConfig } from "@/hooks";
import type { PRD } from "@/prd";
import { RunStateKeeper } from "@/runstate";
import { SessionManager } from "@/session";
import { _gitDeps } from "@/utils/git";

/** `/tmp/feat`-shaped fixture: a feature dir so the resume seam is written. */
const FEATURE_DIR = "/tmp/nax-runner-resume/feat-x";

function makeMinimalOptions(overrides: Partial<RunOptions> = {}): RunOptions {
  const config = {} as NaxConfig;
  const hooks = {} as LoadedHooksConfig;
  return {
    prdPath: "/tmp/does-not-exist/prd.json",
    workdir: "/tmp/nax-runner-resume",
    config,
    hooks,
    feature: "feat-x",
    featureDir: FEATURE_DIR,
    dryRun: false,
    useBatch: false,
    statusFile: "/tmp/nax-runner-resume/status.json",
    logFilePath: undefined,
    formatterMode: "quiet",
    headless: true,
    skipPrecheck: true,
    ...overrides,
  };
}

function makeCompletePrd(): PRD {
  return makePRD({
    feature: "test-feature",
    userStories: [
      makeStory({ id: "US-001", title: "Story 1", description: "Test story", status: "passed", passes: true }),
    ],
  });
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
    sealApprovals: async () => {},
  };
}

/**
 * Stub the three runner phases so a run reaches its outer `finally` and then
 * throws from the execution phase — the path the setup-error catch does NOT cover.
 */
function stubPhasesThatThrowAfterSetup(prd: PRD): void {
  _runnerDeps.runSetupPhase = mock(async () => makeSetupResult(prd)) as typeof _runnerDeps.runSetupPhase;
  _runnerDeps.runExecutionPhase = mock(async () => {
    throw new Error("simulated execution failure");
  }) as typeof _runnerDeps.runExecutionPhase;
  _runnerDeps.cleanupRun = mock(async () => {}) as typeof _runnerDeps.cleanupRun;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let origRunSetupPhase: typeof _runnerDeps.runSetupPhase;
let origRunnerDeps: typeof _runnerDeps;
let origMode: ResumeMode;
let origGitSpawn: typeof _gitDeps.spawn;

beforeEach(() => {
  origRunSetupPhase = _runnerDeps.runSetupPhase;
  origRunnerDeps = { ..._runnerDeps };
  origMode = _workflowResumeDeps.mode;
  origGitSpawn = _gitDeps.spawn;
  // #2497: keep the run-state keeper off the real filesystem.
  _runnerDeps.activateRunState = async () => ({ keeper: new RunStateKeeper("r", "f"), deactivate: () => {} });
  // The finally block resolves the current branch via gitWithTimeout.
  _gitDeps.spawn = makeSpawn().spawn;
  _runnerReentrancyGuard.inFlight = false;
});

afterEach(() => {
  _runnerDeps.runSetupPhase = origRunSetupPhase;
  Object.assign(_runnerDeps, origRunnerDeps);
  _workflowResumeDeps.mode = origMode;
  _gitDeps.spawn = origGitSpawn;
  // Safety net: a failing assertion mid-test must not leave the guard stuck
  // `true` and break every subsequent test's `run()` call.
  _runnerReentrancyGuard.inFlight = false;
  (mock as { restore?: () => void }).restore?.();
});

// ---------------------------------------------------------------------------
// AC-5 / AC-6 — workflow resume mode survives a setup-phase failure
// ---------------------------------------------------------------------------

describe("runner.run() — workflow resume mode (AC-5, AC-6)", () => {
  test("AC-5: a stubbed setup phase that throws rejects the run", async () => {
    _runnerDeps.runSetupPhase = (async () => {
      throw new Error("fresh-mode setup failure");
    }) as typeof _runnerDeps.runSetupPhase;

    await expect(run(makeMinimalOptions({ resumeMode: "fresh" }))).rejects.toThrow("fresh-mode setup failure");
  });

  test("AC-6: the mode is restored to the value it held before the call", async () => {
    // A non-default prior value, so a run() that never wrote the seam fails this
    // as loudly as one that wrote it and never restored it.
    _workflowResumeDeps.mode = "no-resume";
    _runnerDeps.runSetupPhase = (async () => {
      throw new Error("fresh-mode setup failure");
    }) as typeof _runnerDeps.runSetupPhase;

    await expect(run(makeMinimalOptions({ resumeMode: "fresh" }))).rejects.toThrow("fresh-mode setup failure");

    expect(_workflowResumeDeps.mode).toBe("no-resume");
  });

  test("the mode is already 'fresh' while the setup phase runs", async () => {
    let modeDuringSetup: ResumeMode | undefined;
    _runnerDeps.runSetupPhase = (async () => {
      modeDuringSetup = _workflowResumeDeps.mode;
      // End the run here: the assertion is about what the setup phase observes.
      throw new Error("observed the setup phase");
    }) as typeof _runnerDeps.runSetupPhase;

    await expect(run(makeMinimalOptions({ resumeMode: "fresh", featureDir: "/tmp/feat-fresh" }))).rejects.toThrow(
      "observed the setup phase",
    );

    expect(modeDuringSetup).toBe("fresh");
  });

  test("the mode is restored on the outer finally — a throw after setup restores it too", async () => {
    _workflowResumeDeps.mode = "no-resume";
    stubPhasesThatThrowAfterSetup(makeCompletePrd());

    await expect(run(makeMinimalOptions({ resumeMode: "fresh" }))).rejects.toThrow("simulated execution failure");

    expect(_workflowResumeDeps.mode).toBe("no-resume");
  });
});

// ---------------------------------------------------------------------------
// The orchestrator checkpoint deps are no longer this module's business
// ---------------------------------------------------------------------------

describe("runner.run() — orchestrator checkpoint deps are untouched", () => {
  test("run() neither wires nor mutates _storyOrchestratorDeps during a run", async () => {
    const beforeLoad = _storyOrchestratorDeps.loadCheckpoints;
    const beforeRecord = _storyOrchestratorDeps.recordGreen;
    let loadDuringSetup: typeof _storyOrchestratorDeps.loadCheckpoints | undefined;
    let recordDuringSetup: typeof _storyOrchestratorDeps.recordGreen | undefined;

    _runnerDeps.runSetupPhase = (async () => {
      loadDuringSetup = _storyOrchestratorDeps.loadCheckpoints;
      recordDuringSetup = _storyOrchestratorDeps.recordGreen;
      throw new Error("observed the setup phase");
    }) as typeof _runnerDeps.runSetupPhase;

    await expect(run(makeMinimalOptions({ resumeMode: "auto" }))).rejects.toThrow("observed the setup phase");

    // Same function references throughout: nothing was swapped in for the run
    // (auto mode used to install a reader bound to the feature dir, fresh mode
    // an empty-Map stub) and nothing needed restoring afterwards.
    expect(loadDuringSetup).toBe(beforeLoad);
    expect(recordDuringSetup).toBe(beforeRecord);
    expect(_storyOrchestratorDeps.loadCheckpoints).toBe(beforeLoad);
    expect(_storyOrchestratorDeps.recordGreen).toBe(beforeRecord);
  });
});

// ---------------------------------------------------------------------------
// Reentrancy guard
// ---------------------------------------------------------------------------

/**
 * `run()` reentrancy guard (`_runnerReentrancyGuard`).
 *
 * A second concurrent `run()` call would race on the module-global seams
 * `run()` writes for its duration — the workflow resume mode among them — so
 * the guard turns that race into an immediate, explicit `NaxError` instead of
 * silent cross-run corruption.
 */
describe("runner.run() — reentrancy guard", () => {
  test("run() rejects with NaxError(RUNNER_REENTRANT_CALL) when another run() is already in flight", async () => {
    _runnerReentrancyGuard.inFlight = true;

    let caught: unknown;
    try {
      await run(makeMinimalOptions());
    } catch (err) {
      caught = err;
    }

    assertCaughtInstanceOf(caught, NaxError, "run() reentrant call");
    expect(caught.code).toBe("RUNNER_REENTRANT_CALL");
    expect(caught.context?.stage).toBe("execution");
  });

  test("the guard is false before the first call and stays false after a setup-phase throw", async () => {
    expect(_runnerReentrancyGuard.inFlight).toBe(false);

    _runnerDeps.runSetupPhase = (async () => {
      // Assert the guard is held WHILE run() is in flight, proving it is set
      // before mutating shared state rather than only on the failure path.
      expect(_runnerReentrancyGuard.inFlight).toBe(true);
      throw new Error("simulated setup failure");
    }) as typeof _runnerDeps.runSetupPhase;

    await expect(run(makeMinimalOptions())).rejects.toThrow("simulated setup failure");

    expect(_runnerReentrancyGuard.inFlight).toBe(false);
  });

  test("the guard is released after a successful run, allowing a subsequent run() to proceed", async () => {
    _runnerDeps.runSetupPhase = (async () => {
      throw new Error("first run setup failure");
    }) as typeof _runnerDeps.runSetupPhase;
    await expect(run(makeMinimalOptions())).rejects.toThrow("first run setup failure");
    expect(_runnerReentrancyGuard.inFlight).toBe(false);

    // A second run() call must not be rejected as reentrant — the guard was
    // correctly released by the first run's finally/catch path.
    _runnerDeps.runSetupPhase = (async () => {
      throw new Error("second run setup failure");
    }) as typeof _runnerDeps.runSetupPhase;
    let caught: unknown;
    try {
      await run(makeMinimalOptions());
    } catch (err) {
      caught = err;
    }
    assertCaughtInstanceOf(caught, Error, "runSetupPhase rejection");
    expect(caught.message).toBe("second run setup failure");
    expect(caught).not.toBeInstanceOf(NaxError);
  });
});
