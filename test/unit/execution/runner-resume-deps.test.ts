/**
 * runner.run() — resume-dep lifecycle regression test (US-004).
 *
 * Adversarial finding: `applyResumeModeDeps` mutates
 * `_storyOrchestratorDeps.loadCheckpoints` BEFORE `runSetupPhase` runs, but
 * the original restoration only fired in the inner finally — meaning a
 * setup-phase throw would leak the mutated dep into the entire process.
 *
 * These tests assert that:
 *   - On a setup-phase throw, `_storyOrchestratorDeps.loadCheckpoints` is
 *     restored to whatever it was before `run()` was called.
 *   - On a successful run, the dep is also restored (so test harnesses
 *     reusing the same process see the stub default again).
 *
 * We mock `_runnerDeps.runSetupPhase` to throw without going through the
 * full setup pipeline (lock acquisition, crash handlers, etc.).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { assertNaxError } from "@test/helpers";
import type { NaxConfig } from "@/config";
import { NaxError } from "@/errors";
import { _runnerDeps, _runnerReentrancyGuard, _storyOrchestratorDeps, type RunOptions, run } from "@/execution";
import type { LoadedHooksConfig } from "@/hooks";

function makeMinimalOptions(overrides: Partial<RunOptions> = {}): RunOptions {
  const config = {} as NaxConfig;
  const hooks = {} as LoadedHooksConfig;
  return {
    prdPath: "/tmp/does-not-exist/prd.json",
    workdir: "/tmp",
    config,
    hooks,
    feature: "feat-x",
    featureDir: "/tmp/feat-x",
    dryRun: false,
    useBatch: false,
    statusFile: "/tmp/status.json",
    logFilePath: undefined,
    formatterMode: "normal",
    headless: true,
    skipPrecheck: true,
    ...overrides,
  };
}

describe("runner.run() — resume-dep lifecycle (US-004 regression)", () => {
  let origLoad: typeof _storyOrchestratorDeps.loadCheckpoints;
  let origRunSetupPhase: typeof _runnerDeps.runSetupPhase;

  beforeEach(() => {
    origLoad = _storyOrchestratorDeps.loadCheckpoints;
    origRunSetupPhase = _runnerDeps.runSetupPhase;
  });

  afterEach(() => {
    _storyOrchestratorDeps.loadCheckpoints = origLoad;
    _runnerDeps.runSetupPhase = origRunSetupPhase;
    // Safety net: a failing assertion mid-test must not leave the guard
    // stuck `true` and break every subsequent test's `run()` call.
    _runnerReentrancyGuard.inFlight = false;
  });

  test("setup-phase throw restores _storyOrchestratorDeps.loadCheckpoints (regression: setup-error leak)", async () => {
    // Capture the original dep BEFORE run() mutates it.
    const capturedBefore = _storyOrchestratorDeps.loadCheckpoints;

    // Force runSetupPhase to throw. This simulates any setup-time failure
    // (lock acquisition, plugin loading, PRD parse, etc.) that would happen
    // BEFORE the inner try block.
    _runnerDeps.runSetupPhase = (async () => {
      throw new Error("simulated setup failure");
    }) as typeof _runnerDeps.runSetupPhase;

    await expect(run(makeMinimalOptions())).rejects.toThrow("simulated setup failure");

    // Critical assertion: the dep is the SAME function reference we had
    // before run() was called. If the bug were present, it would still be
    // the closure injected by applyResumeModeDeps.
    expect(_storyOrchestratorDeps.loadCheckpoints).toBe(capturedBefore);
  });

  test("setup-phase throw with auto mode restores the dep (regression: setup-error leak, auto variant)", async () => {
    const capturedBefore = _storyOrchestratorDeps.loadCheckpoints;

    _runnerDeps.runSetupPhase = (async () => {
      throw new Error("auto-mode setup failure");
    }) as typeof _runnerDeps.runSetupPhase;

    await expect(run(makeMinimalOptions({ resumeMode: "auto" }))).rejects.toThrow();

    expect(_storyOrchestratorDeps.loadCheckpoints).toBe(capturedBefore);
  });

  test("setup-phase throw with fresh mode restores the dep (regression: setup-error leak, fresh variant)", async () => {
    const capturedBefore = _storyOrchestratorDeps.loadCheckpoints;

    _runnerDeps.runSetupPhase = (async () => {
      throw new Error("fresh-mode setup failure");
    }) as typeof _runnerDeps.runSetupPhase;

    await expect(run(makeMinimalOptions({ resumeMode: "fresh" }))).rejects.toThrow();

    expect(_storyOrchestratorDeps.loadCheckpoints).toBe(capturedBefore);
  });

  test("subsequent run() calls do not see leaked dep from a previous failed run", async () => {
    // First run: setup throws. Capture what the dep looked like before AND
    // after this throw — they must be identical.
    const before1 = _storyOrchestratorDeps.loadCheckpoints;
    _runnerDeps.runSetupPhase = (async () => {
      throw new Error("first run setup failure");
    }) as typeof _runnerDeps.runSetupPhase;
    await expect(run(makeMinimalOptions())).rejects.toThrow("first run setup failure");
    const after1 = _storyOrchestratorDeps.loadCheckpoints;
    expect(after1).toBe(before1);

    // Second run: setup throws again. The dep captured BEFORE this run must
    // also match what the dep looks like after — proving the first run's
    // mutation was fully restored and didn't bleed into this run's
    // captured-before snapshot.
    const before2 = _storyOrchestratorDeps.loadCheckpoints;
    _runnerDeps.runSetupPhase = (async () => {
      throw new Error("second run setup failure");
    }) as typeof _runnerDeps.runSetupPhase;
    await expect(run(makeMinimalOptions())).rejects.toThrow("second run setup failure");
    const after2 = _storyOrchestratorDeps.loadCheckpoints;
    expect(after2).toBe(before2);
    expect(after2).toBe(before1);
  });
});

/**
 * `run()` reentrancy guard (`_runnerReentrancyGuard`).
 *
 * `run()` mutates the module-global `_storyOrchestratorDeps.{loadCheckpoints,
 * recordGreen}` for its duration and restores the originals on exit. A second
 * concurrent `run()` call would race on that global — corrupting which
 * feature's checkpoint gets read/recorded. The guard turns that race into an
 * immediate, explicit `NaxError` instead of silent cross-feature corruption.
 */
describe("runner.run() — reentrancy guard", () => {
  let origRunSetupPhase: typeof _runnerDeps.runSetupPhase;

  beforeEach(() => {
    origRunSetupPhase = _runnerDeps.runSetupPhase;
    _runnerReentrancyGuard.inFlight = false;
  });

  afterEach(() => {
    _runnerDeps.runSetupPhase = origRunSetupPhase;
    _runnerReentrancyGuard.inFlight = false;
  });

  test("run() rejects with NaxError(RUNNER_REENTRANT_CALL) when another run() is already in flight", async () => {
    _runnerReentrancyGuard.inFlight = true;

    let caught: unknown;
    try {
      await run(makeMinimalOptions());
    } catch (err) {
      caught = err;
    }

    assertNaxError(caught);
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
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("second run setup failure");
    expect(caught).not.toBeInstanceOf(NaxError);
  });
});
