/**
 * run-setup.ts — US-003 AC14: `setupRun` delegates `.nax/` auto-migration to
 * the injected seam, exactly once, after the PRD loads.
 *
 * The seam exists so the migration's own behaviour (partition, warn, info logs,
 * never rejecting) can be tested against `autoMigrateGeneratedContent` directly
 * while this file pins the wiring: one call, with the run's workdir.
 *
 * Split out of run-setup.test.ts, alongside run-setup-locks.test.ts and
 * run-setup-approvals-seal.test.ts, which use the same harness shape.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupTempDir,
  makeMockRuntime,
  makeNaxConfig,
  makePRD,
  makeStory,
  makeTempDir,
  withDepsRestore,
} from "@test/helpers";
import { LockAcquisitionError } from "@/errors";
import { _runSetupDeps, type RunSetupOptions, setupRun } from "@/execution/lifecycle/run-setup";

const tempDirs: string[] = [];

// Save/restore every `_runSetupDeps` entry — including the US-003
// autoMigrateGeneratedContent seam — around each test.
withDepsRestore(_runSetupDeps);

afterEach(() => {
  for (const dir of tempDirs.splice(0)) cleanupTempDir(dir);
});

interface AutoMigrateHarness {
  readonly options: RunSetupOptions;
  /** Every workdir `setupRun` handed to the injected auto-migration seam. */
  readonly calls: string[];
}

/**
 * Stub every heavy seam `setupRun` needs and record the auto-migration calls.
 * The PRD holds one already-`passed` story, so `setupRun` runs to completion
 * without touching the network, the PATH or the filesystem beyond its workdir.
 */
function installHarness(): AutoMigrateHarness {
  const workdir = makeTempDir("nax-runsetup-automigrate-");
  tempDirs.push(workdir);
  const prdPath = join(workdir, "prd.json");
  writeFileSync(
    prdPath,
    JSON.stringify(
      makePRD({
        feature: "automigrate-feature",
        userStories: [makeStory({ id: "US-001", status: "passed", passes: true, workdir: "packages/app" })],
      }),
      null,
      2,
    ),
    "utf8",
  );

  const runtime = makeMockRuntime({ workdir });
  Object.defineProperty(runtime, "outputDir", {
    value: join(workdir, "nax-out"),
    writable: false,
    configurable: true,
  });

  const calls: string[] = [];
  _runSetupDeps.createRuntime = () => runtime;
  _runSetupDeps.detectProjectProfile = async () => ({ language: "typescript" });
  // No real signal handlers: setupRun only needs a cleanup function back.
  _runSetupDeps.installCrashHandlers = () => () => {};
  _runSetupDeps.buildApprovalsSeal = async () => async () => {};
  _runSetupDeps.autoMigrateGeneratedContent = async (targetWorkdir: string): Promise<void> => {
    calls.push(targetWorkdir);
  };

  return {
    options: {
      prdPath,
      workdir,
      // Acceptance enabled would make the run reach for the default agent
      // binary (`which`), which is unrelated to this story and flaky.
      config: makeNaxConfig({ acceptance: { enabled: false } }),
      hooks: { hooks: {} },
      feature: "automigrate-feature",
      dryRun: false,
      statusFile: join(workdir, "status.json"),
      runId: "run-automigrate-setup",
      startedAt: new Date().toISOString(),
      startTime: Date.now(),
      skipPrecheck: true,
      headless: true,
      formatterMode: "quiet",
      getTotalCost: () => 0,
      getIterations: () => 0,
      getStoriesCompleted: () => 0,
      getTotalStories: () => 0,
    },
    calls,
  };
}

describe("setupRun — US-003 AC14: .nax/ auto-migration seam", () => {
  test("US-003 AC14: calls autoMigrateGeneratedContent exactly once with the run's workdir", async () => {
    const harness = installHarness();

    const result = await setupRun(harness.options);
    try {
      expect(harness.calls).toEqual([harness.options.workdir]);
    } finally {
      result.cleanupCrashHandlers();
    }
  });

  test("US-003 AC14 boundary: the call is observed even when setupRun rejects at a later step", async () => {
    const harness = installHarness();
    // Lock acquisition is the first thing that can refuse AFTER the PRD loads,
    // so it forces a rejection downstream of the auto-migration call.
    const acquireLockRefusal: typeof _runSetupDeps.acquireLock = async () => ({
      acquired: false,
      holder: { pid: 424_242, host: "holder-machine" },
    });
    _runSetupDeps.acquireLock = acquireLockRefusal;

    const error = await setupRun(harness.options).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LockAcquisitionError);
    expect(harness.calls).toEqual([harness.options.workdir]);
  });

  test("US-003 AC14: setupRun migrates nothing itself — the seam owns the migration", async () => {
    const harness = installHarness();
    // A migratable candidate plus a usable outputDir: the block this story
    // replaced would move `.nax/runs/` right here. With the seam stubbed, the
    // migration must not happen twice, or behind the seam's back.
    const outputDir = join(harness.options.workdir, "nax-out");
    await Bun.write(
      join(harness.options.workdir, ".nax", "config.json"),
      JSON.stringify({ name: "delegate-fixture", outputDir }),
    );
    await Bun.write(join(harness.options.workdir, ".nax", "runs", "r.json"), "{}\n");

    const result = await setupRun(harness.options);
    try {
      expect(harness.calls).toEqual([harness.options.workdir]);
      expect(existsSync(join(harness.options.workdir, ".nax", "runs"))).toBe(true);
      expect(existsSync(outputDir)).toBe(false);
    } finally {
      result.cleanupCrashHandlers();
    }
  });
});
