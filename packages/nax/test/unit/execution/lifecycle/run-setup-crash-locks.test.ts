import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
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
import { acquireFeatureLock, featureLockPath } from "@/execution/feature-lock";
import { acquireLock } from "@/execution/helpers";
import { _runSetupDeps, type RunSetupOptions, setupRun } from "@/execution/lifecycle/run-setup";

type CapturedCrashContext = { releaseLocks?: () => Promise<void> };
const tempDirs: string[] = [];
withDepsRestore(_runSetupDeps);

afterEach(() => {
  for (const dir of tempDirs.splice(0)) cleanupTempDir(dir);
});

function makeHarness(): { options: RunSetupOptions; outputDir: string; crashContext: CapturedCrashContext } {
  const workdir = makeTempDir("nax-runsetup-crash-locks-");
  tempDirs.push(workdir);
  const prdPath = join(workdir, "prd.json");
  writeFileSync(
    prdPath,
    JSON.stringify(
      makePRD({
        feature: "crash-locks-feature",
        userStories: [makeStory({ id: "US-001", status: "passed", passes: true, workdir: "packages/app" })],
      }),
    ),
  );
  const outputDir = join(workdir, "nax-out");
  const runtime = makeMockRuntime({ workdir });
  Object.defineProperty(runtime, "outputDir", { value: outputDir, writable: false, configurable: true });
  const crashContext: CapturedCrashContext = {};

  _runSetupDeps.createRuntime = () => runtime;
  _runSetupDeps.createRunMemory = async () => undefined;
  _runSetupDeps.detectProjectProfile = async () => ({});
  _runSetupDeps.installCrashHandlers = (ctx) => {
    Object.assign(crashContext, ctx);
    return () => {};
  };
  _runSetupDeps.buildApprovalsSeal = async () => async () => {};

  return {
    outputDir,
    crashContext,
    options: {
      prdPath,
      workdir,
      config: makeNaxConfig(),
      hooks: { hooks: {} },
      feature: "crash-locks-feature",
      dryRun: false,
      statusFile: join(workdir, "status.json"),
      runId: "run-crash-locks",
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
  };
}

describe("setupRun releaseLocks forwarder — US-004", () => {
  test("AC-7: releases the acquired feature and checkout locks", async () => {
    const { options, outputDir, crashContext } = makeHarness();
    const result = await setupRun(options);
    try {
      expect(await Bun.file(join(options.workdir, "nax.lock")).exists()).toBe(true);
      expect(await Bun.file(featureLockPath(outputDir, options.feature)).exists()).toBe(true);
      expect(typeof crashContext.releaseLocks).toBe("function");
      await crashContext.releaseLocks?.();
      expect(await Bun.file(join(options.workdir, "nax.lock")).exists()).toBe(false);
      expect(await Bun.file(featureLockPath(outputDir, options.feature)).exists()).toBe(false);
      expect(
        await acquireFeatureLock({
          outputDir,
          feature: options.feature,
          workdir: options.workdir,
          runId: "replacement-run",
        }),
      ).toMatchObject({ acquired: true });
    } finally {
      result.cleanupCrashHandlers();
      await result.runtime.close();
      await acquireLock(options.workdir).then(async (acquired) => {
        if (acquired.acquired) {
          const { releaseLock } = await import("@/execution/helpers");
          await releaseLock(options.workdir);
        }
      });
    }
  });

  test("AC-8: a checkout-lock refusal leaves a later holder's lock untouched", async () => {
    const { options, crashContext } = makeHarness();
    _runSetupDeps.acquireLock = async () => ({ acquired: false, holder: { pid: 41001, host: "other" } });
    await expect(setupRun(options)).rejects.toThrow();
    const lockPath = join(options.workdir, "nax.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: 41001, host: "other" }));
    expect(typeof crashContext.releaseLocks).toBe("function");
    await crashContext.releaseLocks?.();
    expect(await Bun.file(lockPath).text()).toContain("41001");
  });

  test("AC-9: a feature-lock refusal leaves a later checkout holder's lock untouched", async () => {
    const { options, crashContext } = makeHarness();
    _runSetupDeps.acquireFeatureLock = async () => ({
      acquired: false,
      holder: {
        pid: 41002,
        host: "other",
        workdir: "/other/workdir",
        feature: options.feature,
        runId: "other-run",
        startedAt: new Date().toISOString(),
        timestamp: Date.now(),
      },
    });
    await expect(setupRun(options)).rejects.toThrow();
    const lockPath = join(options.workdir, "nax.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: 41002, host: "other" }));
    expect(typeof crashContext.releaseLocks).toBe("function");
    await crashContext.releaseLocks?.();
    expect(await Bun.file(lockPath).text()).toContain("41002");
  });
});
