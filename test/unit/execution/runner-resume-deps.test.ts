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

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { LoadedHooksConfig } from "@/hooks";
import type { NaxConfig } from "@/config";
import { _runnerDeps, run, type RunOptions } from "@/execution";
import { _storyOrchestratorDeps } from "@/execution";

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