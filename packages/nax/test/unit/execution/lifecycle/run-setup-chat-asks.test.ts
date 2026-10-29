import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { basename, join } from "node:path";
import { cleanupTempDir, makeMockRuntime, makeNaxConfig, makePRD, makeTempDir, withDepsRestore } from "@test/helpers";
import { releaseFeatureLock } from "@/execution/feature-lock";
import { releaseLock } from "@/execution/helpers";
import { _runSetupDeps, type RunSetupOptions, setupRun } from "@/execution/lifecycle/run-setup";
import { runSetupPhase } from "@/execution/runner-setup";
import { InteractionChain } from "@/interaction";
import type { NaxRuntime } from "@/runtime";

describe("setupRun — chat asks", () => {
  withDepsRestore(_runSetupDeps);
  const runtimes: NaxRuntime[] = [];
  let workdir: string;
  let options: RunSetupOptions;
  const secret = new Uint8Array(32).fill(7);
  const chain = new InteractionChain({ defaultTimeout: 1_000, defaultFallback: "abort" });
  const initInteractionChain = mock(async () => chain);
  const cleanupCrashHandlers = mock(() => {});

  beforeEach(async () => {
    workdir = makeTempDir("nax-test-setup-chat-asks-");
    const config = makeNaxConfig({ name: basename(workdir), outputDir: join(workdir, "out") });
    const prdPath = join(workdir, "prd.json");
    await Bun.write(prdPath, JSON.stringify(makePRD({ feature: "chat-asks", userStories: [] })));
    options = {
      prdPath,
      workdir,
      config,
      hooks: { hooks: {} },
      feature: "chat-asks",
      dryRun: true,
      statusFile: join(workdir, "status.json"),
      runId: "run-chat-asks",
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
    initInteractionChain.mockClear();
    cleanupCrashHandlers.mockClear();
    _runSetupDeps.initInteractionChain = initInteractionChain;
    _runSetupDeps.installCrashHandlers = () => cleanupCrashHandlers;
    _runSetupDeps.createRuntime = () => {
      const runtime = makeMockRuntime({ workdir, config, dryRun: true });
      runtimes.push(runtime);
      return runtime;
    };
    _runSetupDeps.detectProjectProfile = async () => ({});
    _runSetupDeps.sweepFeatureTranscripts = async () => 0;
    _runSetupDeps.buildApprovalsSeal = async () => async () => {};
  });

  afterEach(async () => {
    for (const runtime of runtimes) {
      await releaseFeatureLock({ outputDir: runtime.outputDir, feature: options.feature, runId: options.runId });
      await runtime.close();
    }
    runtimes.length = 0;
    await releaseLock(workdir);
    cleanupTempDir(workdir);
  });

  test("AC-1: real setupRun forwards the directory and secret to interaction init", async () => {
    await setupRun({ ...options, chatAsksDir: "/tmp/asks", chatAskSecret: secret });
    expect(initInteractionChain).toHaveBeenCalledTimes(1);
    expect(initInteractionChain).toHaveBeenCalledWith(options.config, true, {
      chatAsksDir: "/tmp/asks",
      chatAskSecret: secret,
    });
  });

  test("AC-2: absent directory supplies an explicit undefined third argument", async () => {
    await setupRun(options);
    expect(initInteractionChain).toHaveBeenCalledTimes(1);
    expect(initInteractionChain).toHaveBeenCalledWith(options.config, true, undefined);
  });

  test("AC-3: runSetupPhase reaches real interaction init with directory and secret", async () => {
    await runSetupPhase({ ...options, chatAsksDir: "/tmp/asks", chatAskSecret: secret });
    expect(initInteractionChain).toHaveBeenCalledTimes(1);
    expect(initInteractionChain).toHaveBeenCalledWith(options.config, true, {
      chatAsksDir: "/tmp/asks",
      chatAskSecret: secret,
    });
  });

  test("AC-4: setupRun resolves with the exact returned chain", async () => {
    const result = await setupRun(options);
    expect(result.interactionChain).toBe(chain);
  });

  test("interaction-init errors propagate through setup failure cleanup", async () => {
    const failure = new Error("interaction init failed");
    _runSetupDeps.initInteractionChain = mock(async () => {
      throw failure;
    });
    await expect(setupRun(options)).rejects.toBe(failure);
    expect(cleanupCrashHandlers).toHaveBeenCalledTimes(1);
    expect(runtimes[0]?.signal.aborted).toBe(true);
  });
});
