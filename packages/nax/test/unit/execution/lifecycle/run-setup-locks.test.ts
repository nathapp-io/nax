/**
 * run-setup.ts — US-002: setupRun acquires the checkout lock then the feature
 * lock, unwinds a partial acquire, and refuses with holder-naming errors.
 *
 * Split out of run-setup.test.ts (which these cases pushed past the 800-line
 * test limit) and kept as the paired half of run-cleanup-locks.test.ts: this
 * file pins the acquisition + refusal side, that file pins the always-release.
 *
 * Determinism comes from the `_runSetupDeps` seams — `acquireLock` /
 * `acquireFeatureLock` are injected to force refusals and record order — while
 * the surrounding pipeline (createRuntime/detectProjectProfile/sweep) is
 * stubbed exactly as the existing AC10 sweep test stubs it, so setupRun
 * reliably reaches the lock section.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertCaughtInstanceOf,
  assertDefined,
  cleanupTempDir,
  makeMockRuntime,
  makeNaxConfig,
  makePRD,
  makeTempDir,
  withDepsRestore,
} from "@test/helpers";
import { LockAcquisitionError } from "@/errors";
import { _runSetupDeps, type RunSetupOptions, setupRun } from "@/execution/lifecycle/run-setup";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";
import type { NaxRuntime } from "@/runtime";

const runtimesToClose: NaxRuntime[] = [];

afterEach(async () => {
  await Promise.allSettled(runtimesToClose.map((r) => r.close()));
  runtimesToClose.length = 0;
});

// Save/restore every `_runSetupDeps` entry (including the US-002
// acquireLock/acquireFeatureLock seams) around each test.
withDepsRestore(_runSetupDeps);

interface LockHarness {
  workdir: string;
  outputDir: string;
  feature: string;
  runId: string;
  options: RunSetupOptions;
}

function writeValidPrd(prdPath: string): void {
  const prd = makePRD({ feature: "locks-feature", userStories: [] });
  writeFileSync(prdPath, JSON.stringify(prd, null, 2), "utf8");
}

function makeHarness(): LockHarness {
  const workdir = makeTempDir("nax-test-runsetup-locks-");
  const outputDir = join(workdir, "nax-out");
  const feature = "locks-feature";
  const runId = `run-${feature}-${Date.now()}`;
  const prdPath = join(workdir, "prd.json");
  writeValidPrd(prdPath);
  const options: RunSetupOptions = {
    prdPath,
    workdir,
    config: makeNaxConfig(),
    hooks: { hooks: {} },
    feature,
    dryRun: false,
    statusFile: join(workdir, "status.json"),
    runId,
    startedAt: new Date().toISOString(),
    startTime: Date.now(),
    skipPrecheck: true,
    headless: true,
    formatterMode: "quiet",
    getTotalCost: () => 0,
    getIterations: () => 0,
    getStoriesCompleted: () => 0,
    getTotalStories: () => 0,
  };
  return { workdir, outputDir, feature, runId, options };
}

/**
 * Stub the surrounding pipeline exactly like the existing AC10 sweep test so
 * setupRun reaches the lock section, and pin the runtime's outputDir (where the
 * feature lock lives). Returns the runtime so tests can build harness-specific
 * seeds.
 */
function installRuntimeMocks(harness: { workdir: string; outputDir: string }): NaxRuntime {
  const baseRuntime = makeMockRuntime({ workdir: harness.workdir });
  Object.defineProperty(baseRuntime, "outputDir", {
    value: harness.outputDir,
    writable: false,
    configurable: true,
  });
  runtimesToClose.push(baseRuntime);

  const createRuntimeStub: typeof _runSetupDeps.createRuntime = () => baseRuntime;
  const detectProfileStub: typeof _runSetupDeps.detectProjectProfile = async () => ({});
  const sweepStub: typeof _runSetupDeps.sweepFeatureTranscripts = async () => 0;

  _runSetupDeps.createRuntime = createRuntimeStub;
  _runSetupDeps.detectProjectProfile = detectProfileStub;
  _runSetupDeps.sweepFeatureTranscripts = sweepStub;
  return baseRuntime;
}

/** Run setupRun and return the thrown error (undefined when it resolves). */
async function captureSetupError(options: RunSetupOptions): Promise<unknown> {
  try {
    await setupRun(options);
    return undefined;
  } catch (err) {
    return err;
  }
}

describe("setupRun — US-002: both locks held, in order", () => {
  test("US-002 AC1: acquires the checkout lock before the feature lock, passing feature/workdir/runId/outputDir", async () => {
    const h = makeHarness();
    installRuntimeMocks(h);

    const callOrder: string[] = [];
    let featureArgs: { outputDir: string; feature: string; workdir: string; runId: string } | undefined;
    const acquireLockStub: typeof _runSetupDeps.acquireLock = async () => {
      callOrder.push("checkout");
      return { acquired: true };
    };
    const acquireFeatureLockStub: typeof _runSetupDeps.acquireFeatureLock = async (args) => {
      callOrder.push("feature");
      featureArgs = args;
      return { acquired: true };
    };
    _runSetupDeps.acquireLock = acquireLockStub;
    _runSetupDeps.acquireFeatureLock = acquireFeatureLockStub;

    try {
      // setupRun may reject later (post-lock steps are real) — the order was
      // already recorded the moment each seam fired.
      await setupRun(h.options).catch(() => {});

      expect(callOrder).toEqual(["checkout", "feature"]);

      assertDefined(featureArgs, "acquireFeatureLock args");
      expect(featureArgs.outputDir).toBe(h.outputDir);
      expect(featureArgs.feature).toBe(h.feature);
      expect(featureArgs.workdir).toBe(h.workdir);
      expect(featureArgs.runId).toBe(h.runId);
    } finally {
      cleanupTempDir(h.workdir);
    }
  });

  test("US-002 AC2: when acquireFeatureLock refuses, no nax.lock remains in the working directory", async () => {
    const h = makeHarness();
    installRuntimeMocks(h);

    // Feature lock refused by another run holding the same feature.
    const acquireFeatureLockRefusal: typeof _runSetupDeps.acquireFeatureLock = async () => ({
      acquired: false,
      holder: {
        pid: 7,
        host: "holder-host",
        workdir: "/other/checkout",
        feature: h.feature,
        runId: "other-run",
        startedAt: new Date().toISOString(),
        timestamp: Date.now(),
      },
    });
    _runSetupDeps.acquireFeatureLock = acquireFeatureLockRefusal;

    try {
      const err = await captureSetupError(h.options);
      expect(err).toBeInstanceOf(LockAcquisitionError);

      // The checkout lock this run took must have been released before the
      // refusal escaped — no nax.lock may survive setupRun.
      expect(await Bun.file(join(h.workdir, "nax.lock")).exists()).toBe(false);
    } finally {
      cleanupTempDir(h.workdir);
    }
  });

  test("US-002 AC3/AC5: when acquireLock refuses, the error names the working directory and the holding PID", async () => {
    const h = makeHarness();
    installRuntimeMocks(h);

    const holderPid = 424_242;
    const acquireLockRefusal: typeof _runSetupDeps.acquireLock = async () => ({
      acquired: false,
      holder: { pid: holderPid, host: "holder-machine" },
    });
    _runSetupDeps.acquireLock = acquireLockRefusal;

    try {
      const err = await captureSetupError(h.options);
      assertCaughtInstanceOf(err, LockAcquisitionError, "setupRun checkout refusal");

      expect(err.code).toBe("LOCK_ACQUISITION_FAILED");
      // The working directory stays on the error (context)…
      expect(err.context?.workdir).toBe(h.workdir);
      // …and the message names the holding PID.
      expect(err.message).toContain("PID");
      expect(err.message).toContain(String(holderPid));
    } finally {
      cleanupTempDir(h.workdir);
    }
  });

  test("US-002 AC4/AC5: when acquireFeatureLock refuses, the error names the feature, holder workdir, host and PID", async () => {
    const h = makeHarness();
    installRuntimeMocks(h);

    const holderWorkdir = "/owners/checkout";
    const acquireFeatureLockRefusal: typeof _runSetupDeps.acquireFeatureLock = async () => ({
      acquired: false,
      holder: {
        pid: 9,
        host: "owner-machine",
        workdir: holderWorkdir,
        feature: h.feature,
        runId: "owner-run",
        startedAt: new Date().toISOString(),
        timestamp: Date.now(),
      },
    });
    _runSetupDeps.acquireFeatureLock = acquireFeatureLockRefusal;

    try {
      const err = await captureSetupError(h.options);
      assertCaughtInstanceOf(err, LockAcquisitionError, "setupRun feature refusal");

      expect(err.code).toBe("LOCK_ACQUISITION_FAILED");
      expect(err.message).toContain(`Feature "${h.feature}"`);
      expect(err.message).toContain("PID 9 on owner-machine");
      expect(err.message).toContain(holderWorkdir);
    } finally {
      cleanupTempDir(h.workdir);
    }
  });

  test("US-002 AC6: when post-lock initialization fails, neither the checkout lock file nor the feature lock file remains", async () => {
    const h = makeHarness();
    installRuntimeMocks(h);

    // A live feature lock held by THIS run with a matching runId, so that the
    // release path is observable on disk.
    const featureLockPath = join(h.outputDir, "features", h.feature, "nax.lock");
    mkdirSync(join(h.outputDir, "features", h.feature), { recursive: true });
    await Bun.write(
      featureLockPath,
      JSON.stringify({
        pid: process.pid,
        host: "test-machine",
        workdir: h.workdir,
        feature: h.feature,
        runId: h.runId,
        startedAt: new Date().toISOString(),
        timestamp: Date.now(),
      }),
    );

    // Acquires succeed (feature lock "acquired" — the file is our seed), then
    // the first step of post-lock initialization fails.
    const acquireFeatureLockOk: typeof _runSetupDeps.acquireFeatureLock = async () => ({ acquired: true });
    _runSetupDeps.acquireFeatureLock = acquireFeatureLockOk;
    const sweepThrowStub: typeof _runSetupDeps.sweepFeatureTranscripts = async () => {
      throw new Error("[test] post-lock init failed");
    };
    _runSetupDeps.sweepFeatureTranscripts = sweepThrowStub;

    try {
      const err = await captureSetupError(h.options);
      expect(err).not.toBeUndefined();

      expect(await Bun.file(join(h.workdir, "nax.lock")).exists()).toBe(false);
      expect(await Bun.file(featureLockPath).exists()).toBe(false);
    } finally {
      cleanupTempDir(h.workdir);
    }
  });

  test("US-002: checkout-lock refusal pipeline errors carry storyId so log entries are attributable", async () => {
    // The two `logger.error("execution", …)` calls the checkout-lock
    // refusal emits at src/execution/lifecycle/run-setup.ts:380-381 must
    // carry a `storyId` in their `data`, matching the convention every
    // other log call in this file uses (e.g. line 313: `{ storyId: "_setup" }`).
    // The replay/reconstruct consumer falls back to `entry.data?.storyId`
    // (src/replay/reconstruct.ts:117) when the top-level `entry.storyId`
    // is absent, so leaving `data.storyId` unset would orphan the refusal
    // entries from the run's log filter — the exact bug this test pins.
    resetLogger();
    initLogger({ level: "silent", suppressConsole: true });
    const entries: LogEntry[] = [];
    const unsubscribe = addSink((entry) => entries.push(entry));

    const h = makeHarness();
    installRuntimeMocks(h);

    const holderPid = 123_456;
    const acquireLockRefusal: typeof _runSetupDeps.acquireLock = async () => ({
      acquired: false,
      holder: { pid: holderPid, host: "holder-machine" },
    });
    _runSetupDeps.acquireLock = acquireLockRefusal;

    try {
      const err = await captureSetupError(h.options);
      assertCaughtInstanceOf(err, LockAcquisitionError, "setupRun checkout refusal");

      // The checkout-lock refusal must emit two error-level entries on the
      // "execution" pipeline stage (one diagnostic, one remediation hint).
      const pipelineErrors = entries.filter((e) => e.level === "error" && e.stage === "execution");
      expect(pipelineErrors.length).toBeGreaterThanOrEqual(2);

      // Every emitted entry MUST carry a `storyId` in its data so the
      // rest of the pipeline can group it by story for replay/reconstruct.
      const offenders = pipelineErrors.filter((e) => typeof e.data?.storyId !== "string");
      expect(offenders).toEqual([]);

      // Spot-check the actual messages so the test stays honest about
      // which error calls it's covering (the two checkout-refusal lines).
      const messages = pipelineErrors.map((e) => e.message);
      expect(messages).toContain("Another nax process is already running in this directory");
      expect(messages).toContain("If you believe this is an error, remove nax.lock manually");
    } finally {
      unsubscribe();
      resetLogger();
      cleanupTempDir(h.workdir);
    }
  });
});
