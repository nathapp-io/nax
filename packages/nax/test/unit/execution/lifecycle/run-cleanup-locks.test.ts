/**
 * run-cleanup.ts — US-002: cleanup releases the feature lock before the
 * checkout lock, and after cleanup neither lock file remains.
 *
 * Split out of run-cleanup.test.ts (which these cases pushed past the 800-line
 * test limit) and kept as the paired half of run-setup-locks.test.ts: that file
 * pins the acquisition sequence in setupRun, this one pins the always-release
 * at the bottom of cleanupRun. Both release sites touch the same two lock files
 * (`<workdir>/nax.lock` and `<outputDir>/features/<feature>/nax.lock`).
 *
 * The release seam used to observe ordering is `_runCleanupDeps` — the same
 * injectable object that already carries `wipeScratchpad`. The implementer is
 * expected to route cleanupRun's always-release through it.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makePluginRegistry, makePRD, makeTempDir } from "@test/helpers";
import { _runCleanupDeps, cleanupRun } from "@/execution";
import type { RunCleanupOptions } from "@/execution/lifecycle/run-cleanup";

function makeCleanupOptions(overrides: Partial<RunCleanupOptions> = {}): RunCleanupOptions {
  return {
    runId: "run-cleanup-locks",
    startTime: Date.now() - 1000,
    totalCost: 0,
    storiesCompleted: 0,
    prd: makePRD({ feature: "us002-cleanup" }),
    pluginRegistry: makePluginRegistry(),
    workdir: "/tmp/us002-cleanup",
    interactionChain: null,
    feature: "us002-cleanup",
    prdPath: "/tmp/us002-cleanup/.nax/features/us002-cleanup/prd.json",
    branch: "feat/us002",
    version: "1.0.0",
    hooks: { hooks: {} },
    dryRun: false,
    ...overrides,
  };
}

describe("cleanupRun — US-002: releases both locks (feature first)", () => {
  // The seam under test is `_runCleanupDeps.releaseFeatureLock` +
  // `_runCleanupDeps.releaseLock`; saved/restored per test so no sibling suite
  // inherits the stubs.
  let savedReleaseFeature: typeof _runCleanupDeps.releaseFeatureLock;
  let savedRelease: typeof _runCleanupDeps.releaseLock;

  beforeEach(() => {
    savedReleaseFeature = _runCleanupDeps.releaseFeatureLock;
    savedRelease = _runCleanupDeps.releaseLock;
  });

  afterEach(() => {
    _runCleanupDeps.releaseFeatureLock = savedReleaseFeature;
    _runCleanupDeps.releaseLock = savedRelease;
  });

  test("US-002 AC7: releases the feature lock before the checkout lock", async () => {
    const order: string[] = [];
    let featureArgs: unknown;
    let checkoutWorkdir: string | undefined;

    _runCleanupDeps.releaseFeatureLock = mock(async (args: { outputDir: string; feature: string; runId: string }) => {
      featureArgs = args;
      order.push(`feature`);
    }) as typeof _runCleanupDeps.releaseFeatureLock;

    _runCleanupDeps.releaseLock = mock(async (workdir: string) => {
      checkoutWorkdir = workdir;
      order.push(`checkout`);
    }) as typeof _runCleanupDeps.releaseLock;

    await cleanupRun(
      makeCleanupOptions({
        workdir: "/tmp/us002-cleanup",
        outputDir: "/tmp/us002-cleanup/out",
        feature: "auth",
        runId: "run-123",
      }),
    );

    // Feature lock comes down first, checkout lock second — never the reverse.
    expect(order).toEqual(["feature", "checkout"]);
    // The checkout release targets the run's workdir.
    expect(checkoutWorkdir).toBe("/tmp/us002-cleanup");
    // The feature release names the run's feature + output dir + runId.
    const args = featureArgs as { outputDir?: string; feature?: string; runId?: string };
    expect(args.feature).toBe("auth");
    expect(args.outputDir).toBe("/tmp/us002-cleanup/out");
    expect(args.runId).toBe("run-123");
  });

  test("US-002 AC8: after cleanup completes, neither the checkout lock file nor the feature lock file exists", async () => {
    const workdir = makeTempDir("nax-test-cleanup-locks-");
    const outputDir = join(workdir, "out");
    const feature = "auth";
    const runId = "run-123";

    const checkoutLockPath = join(workdir, "nax.lock");
    const featureLockPath = join(outputDir, "features", feature, "nax.lock");

    try {
      // Seed both locks exactly as a live run would leave them: the checkout
      // record (pid+timestamp) and the feature record (runId matching the run).
      await Bun.write(checkoutLockPath, JSON.stringify({ pid: process.pid, timestamp: Date.now() }));
      mkdirSync(join(outputDir, "features", feature), { recursive: true });
      await Bun.write(
        featureLockPath,
        JSON.stringify({
          pid: process.pid,
          host: "test-machine",
          workdir,
          feature,
          runId,
          startedAt: new Date().toISOString(),
          timestamp: Date.now(),
        }),
      );
      expect(await Bun.file(checkoutLockPath).exists()).toBe(true);
      expect(await Bun.file(featureLockPath).exists()).toBe(true);

      await cleanupRun(makeCleanupOptions({ workdir, outputDir, feature, runId }));

      expect(await Bun.file(checkoutLockPath).exists()).toBe(false);
      expect(await Bun.file(featureLockPath).exists()).toBe(false);
    } finally {
      cleanupTempDir(workdir);
    }
  });
});
