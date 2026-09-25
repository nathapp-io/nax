/**
 * run-setup.ts — the end-of-run approvals seal handoff (US-002 AC11–AC13).
 *
 * `setupRun` builds the seal ONCE, right after `initializeAfterLock` returns
 * the loaded PRD, by calling `_runSetupDeps.buildApprovalsSeal` with the run's
 * workdir / root config / story package dirs / output dir / run id. The crash
 * handlers — installed earlier, before the PRD loads — carry a forwarder over
 * the variable the seal lands in, so a signal teardown can seal too; before
 * the seal is built that forwarder does nothing (nothing has run yet).
 *
 * Split out of run-setup.test.ts, which is at the 800-line test limit.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertDefined,
  cleanupTempDir,
  makeMockRuntime,
  makeNaxConfig,
  makePRD,
  makeStory,
  makeTempDir,
  withDepsRestore,
} from "@test/helpers";
import type { NaxConfig } from "@/config";
import { _runSetupDeps, type RunSetupOptions, type RunSetupResult, setupRun } from "@/execution/lifecycle/run-setup";
import { storyPackageDir } from "@/utils/path-frame";

/** The closure `buildApprovalsSeal` returns. */
type ApprovalsSeal = () => Promise<void>;

/**
 * `RunSetupResult` viewed with the US-002 seal. The intersection keeps this
 * file compiling both before and after the required field lands.
 */
type SetupResultWithSeal = RunSetupResult & { sealApprovals?: () => Promise<void> };

/**
 * The options object `setupRun` must hand to `_runSetupDeps.buildApprovalsSeal`.
 * Declared structurally here (rather than imported) so the file fails at an
 * assertion, not at a module link, until the export exists.
 */
interface ApprovalsSealOptions {
  readonly projectDir: string;
  readonly rootConfig: NaxConfig;
  readonly packageDirs: readonly (string | undefined)[];
  readonly outputDir: string;
  readonly runId: string;
}

/** A crash-handler context carrying the forwarder `setupRun` installs. */
interface CrashCtxWithSeal {
  sealApprovals?: () => Promise<void>;
}

const tempDirs: string[] = [];

// Keys added to `_runSetupDeps` during a test are the harness's own; the ones
// that already exist are saved and restored here.
withDepsRestore(_runSetupDeps);

afterEach(() => {
  for (const dir of tempDirs.splice(0)) cleanupTempDir(dir);
});

interface SealHarness {
  readonly options: RunSetupOptions;
  /** What `runtime.outputDir` was pinned to — the seam's `outputDir` argument. */
  readonly outputDir: string;
  /** Every call `setupRun` made to the injected `buildApprovalsSeal`. */
  readonly sealBuilds: ApprovalsSealOptions[];
  /** The closure the injected `buildApprovalsSeal` returned. */
  readonly seal: ReturnType<typeof mock>;
  /** The crash-handler context `setupRun` installed. */
  readonly crashCtx: CrashCtxWithSeal;
}

/**
 * Stub every heavy seam `setupRun` needs and capture the seal wiring. The PRD
 * holds one already-`passed` story, so `initializeRun` needs no agent and
 * `setupRun` runs to completion without touching the network or the PATH.
 */
function installSealHarness(prdPathOverride?: string): SealHarness {
  const workdir = makeTempDir("nax-runsetup-seal-");
  tempDirs.push(workdir);
  const prdPath = join(workdir, "prd.json");
  writeFileSync(
    prdPath,
    JSON.stringify(
      makePRD({
        feature: "seal-feature",
        userStories: [makeStory({ id: "US-001", status: "passed", passes: true, workdir: "packages/app" })],
      }),
      null,
      2,
    ),
    "utf8",
  );

  const outputDir = join(workdir, "nax-out");
  const runtime = makeMockRuntime({ workdir });
  Object.defineProperty(runtime, "outputDir", { value: outputDir, writable: false, configurable: true });

  const sealBuilds: ApprovalsSealOptions[] = [];
  const seal = mock(async () => {});
  const crashCtx: CrashCtxWithSeal = {};

  _runSetupDeps.createRuntime = () => runtime;
  _runSetupDeps.detectProjectProfile = (async () => ({})) as typeof _runSetupDeps.detectProjectProfile;
  _runSetupDeps.installCrashHandlers = (ctx) => {
    // Copy the context's own properties so the forwarder is reachable without
    // reaching past its declared type (the field is new in this story).
    Object.assign(crashCtx, ctx);
    // No real signal handlers: the captured context is what AC13 exercises.
    return () => {};
  };
  Object.assign(_runSetupDeps, {
    buildApprovalsSeal: async (opts: ApprovalsSealOptions): Promise<ApprovalsSeal> => {
      sealBuilds.push(opts);
      return seal;
    },
  });

  return {
    options: {
      prdPath: prdPathOverride ?? prdPath,
      workdir,
      // Acceptance enabled would make the run reach for the default agent
      // binary (`which`), which is unrelated to this story and flaky.
      config: makeNaxConfig({ acceptance: { enabled: false } }),
      hooks: { hooks: {} },
      feature: "seal-feature",
      dryRun: false,
      statusFile: join(workdir, "status.json"),
      runId: "run-seal-setup",
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
    outputDir,
    sealBuilds,
    seal,
    crashCtx,
  };
}

describe("setupRun — US-002 end-of-run approvals seal", () => {
  test("US-002 AC11: setupRun calls buildApprovalsSeal once with the run's workdir, config, outputDir, runId and package dirs", async () => {
    const harness = installSealHarness();

    const result = await setupRun(harness.options);
    try {
      expect(harness.sealBuilds).toHaveLength(1);
      const call = harness.sealBuilds[0];
      assertDefined(call, "buildApprovalsSeal call");
      expect(call.projectDir).toBe(harness.options.workdir);
      expect(call.rootConfig).toBe(harness.options.config);
      expect(call.outputDir).toBe(harness.outputDir);
      expect(call.runId).toBe(harness.options.runId);
      // The story's package dirs, not the workdir: `prd.userStories.map(storyPackageDir)`.
      expect(result.prd.userStories.map(storyPackageDir)).toEqual(["packages/app"]);
      expect(call.packageDirs).toEqual(result.prd.userStories.map(storyPackageDir));
    } finally {
      result.cleanupCrashHandlers();
    }
  });

  test("US-002 AC12: awaiting RunSetupResult.sealApprovals invokes the closure buildApprovalsSeal returned", async () => {
    const harness = installSealHarness();

    const result: SetupResultWithSeal = await setupRun(harness.options);
    try {
      expect(harness.seal).not.toHaveBeenCalled();
      const sealApprovals = result.sealApprovals;
      expect(typeof sealApprovals).toBe("function");
      await sealApprovals?.();
      expect(harness.seal).toHaveBeenCalledTimes(1);
    } finally {
      result.cleanupCrashHandlers();
    }
  });

  test("US-002 AC13: the crash handlers' captured context seals through the same closure", async () => {
    const harness = installSealHarness();

    const result = await setupRun(harness.options);
    try {
      expect(typeof harness.crashCtx.sealApprovals).toBe("function");
      expect(harness.seal).not.toHaveBeenCalled();
      await harness.crashCtx.sealApprovals?.();
      expect(harness.seal).toHaveBeenCalledTimes(1);
    } finally {
      result.cleanupCrashHandlers();
    }
  });

  test("US-002 boundary: a fatal signal before the seal is built seals nothing", async () => {
    // The PRD never loads, so `setupRun` throws before `buildApprovalsSeal` is
    // reached — no dispatch scope has run, so there is nothing to seal and the
    // forwarder installed earlier must be a harmless no-op.
    const missingDir = makeTempDir("nax-runsetup-seal-missing-");
    tempDirs.push(missingDir);
    const harness = installSealHarness(join(missingDir, "absent.json"));

    await expect(setupRun(harness.options)).rejects.toThrow(/PRD file not found/);

    expect(harness.sealBuilds).toEqual([]);
    expect(typeof harness.crashCtx.sealApprovals).toBe("function");
    await harness.crashCtx.sealApprovals?.();
    expect(harness.seal).not.toHaveBeenCalled();
  });
});
