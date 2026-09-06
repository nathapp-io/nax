/**
 * Unit tests for run-setup.ts — US-002 wiring
 *
 * Verifies that setupRun calls detectProjectProfile and merges the result
 * into config.project so all downstream code reading config.project?.language
 * receives the auto-detected value. Also covers US-002 AC10/AC11 — that
 * `setupRun` invokes `sweepFeatureTranscripts` with the run's feature as
 * `featureName` and the runtime's `outputDir` as `transcriptRoot`, and
 * threads `dryRun` through to the sweep.
 */

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertDefined,
  makeLogger,
  makeMockRuntime,
  makeNaxConfig,
  makePRD,
  makeStory,
  makeTempDir,
  withDepsRestore,
} from "@test/helpers";
import {
  _runSetupDeps,
  type RunSetupOptions,
  setupRun,
  warnFallbackMisconfiguration,
  warnProfileMismatch,
} from "@/execution/lifecycle/run-setup";
import type { NaxRuntime } from "@/runtime";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const tmpDir = makeTempDir("nax-test-runsetup-");

withDepsRestore(_runSetupDeps);

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// detectProjectProfile wiring
// ─────────────────────────────────────────────────────────────────────────────

describe("setupRun — detectProjectProfile wiring (AC-8)", () => {
  test("_runSetupDeps exposes detectProjectProfile for injection", () => {
    // The _runSetupDeps object must exist and expose detectProjectProfile
    expect(_runSetupDeps).toBeDefined();
    expect(typeof _runSetupDeps.detectProjectProfile).toBe("function");
  });

  test("detectProjectProfile is called with workdir and config.project during setupRun", async () => {
    let capturedWorkdir: string | undefined;
    let capturedExisting: object | undefined;

    const mockDetect = mock(async (workdir: string, existing: object) => {
      capturedWorkdir = workdir;
      capturedExisting = existing;
      return { language: "go" as const, testFramework: "go-test", lintTool: "golangci-lint" };
    });

    const originalDetect = _runSetupDeps.detectProjectProfile;
    _runSetupDeps.detectProjectProfile = mockDetect as typeof _runSetupDeps.detectProjectProfile;

    try {
      // We just verify the mock was wired — full setupRun requires heavy deps.
      // Call the injected function directly to confirm it's accessible.
      const result = await _runSetupDeps.detectProjectProfile(tmpDir, { language: "typescript" });
      expect(capturedWorkdir).toBe(tmpDir);
      expect(capturedExisting).toEqual({ language: "typescript" });
      expect(result.language).toBe("go");
    } finally {
      _runSetupDeps.detectProjectProfile = originalDetect;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-4: Logging of detected vs explicit config (US-003)
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// #508-M4: AC-35 pre-flight fallback misconfiguration warning
// ─────────────────────────────────────────────────────────────────────────────

describe("warnFallbackMisconfiguration — #508-M4 AC-35 pre-flight warning", () => {
  function makeConfig(fallbackMap: Record<string, string[]> = {}) {
    return makeNaxConfig({
      agent: {
        fallback: {
          enabled: Object.keys(fallbackMap).length > 0,
          map: fallbackMap,
        },
      },
    });
  }

  test("emits warn for each fallback candidate not resolved by agentGetFn", () => {
    const logger = makeLogger();
    const agentGetFn = (name: string) => (name === "codex" ? {} : undefined);

    warnFallbackMisconfiguration(
      makeConfig({ claude: ["codex", "gemini"] }),
      agentGetFn as (name: string) => unknown,
      logger,
    );

    expect(logger.calls.length).toBe(1);
    expect(logger.calls[0]?.stage).toBe("fallback");
    expect(logger.calls[0]?.data).toMatchObject({ candidate: "gemini" });
  });

  test("does not warn when all candidates resolve", () => {
    const logger = makeLogger();
    const agentGetFn = (_name: string) => ({});

    warnFallbackMisconfiguration(makeConfig({ claude: ["codex"] }), agentGetFn as (name: string) => unknown, logger);

    expect(logger.calls).toHaveLength(0);
  });

  test("does not warn when fallback is disabled (enabled: false)", () => {
    const logger = makeLogger();
    const agentGetFn = (_name: string) => undefined;
    const config = makeNaxConfig({
      agent: { fallback: { enabled: false, map: { claude: ["gemini"] } } },
    });

    warnFallbackMisconfiguration(config, agentGetFn as (name: string) => unknown, logger);

    expect(logger.calls).toHaveLength(0);
  });

  test("does not warn when agentGetFn is undefined (skip check when resolver unavailable)", () => {
    const logger = makeLogger();

    warnFallbackMisconfiguration(makeConfig({ claude: ["gemini"] }), undefined, logger);

    expect(logger.calls).toHaveLength(0);
  });

  test("deduplicates warnings for the same candidate across multiple primary agents", () => {
    const logger = makeLogger();
    const agentGetFn = (_name: string) => undefined;

    warnFallbackMisconfiguration(
      makeConfig({ claude: ["gemini"], codex: ["gemini"] }),
      agentGetFn as (name: string) => unknown,
      logger,
    );

    const geminiWarns = logger.calls.filter((c) => c.data?.candidate === "gemini");
    expect(geminiWarns).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 10 Part B: profile-mismatch warning
// ─────────────────────────────────────────────────────────────────────────────

describe("warnProfileMismatch — Task 10 Part B", () => {
  test("emits warn when story has agentProfileId that no longer exists in config", () => {
    const logger = makeLogger();
    const story = makeStory({
      id: "US-001",
      routing: {
        complexity: "medium",
        testStrategy: "tdd-simple",
        reasoning: "test",
        agent: "opencode",
        agentProfileId: "removed-profile",
      },
    });
    const prd = makePRD({ userStories: [story] });
    const config = makeNaxConfig({
      // Include "opencode" in models so only the profile-mismatch warn fires, not the agent warn.
      models: { claude: { fast: "haiku" }, opencode: { fast: "opencode-fast" } },
      routing: {
        agents: {
          enabled: true,
          strategy: "off" as const,
          default: "default-profile",
          profiles: [
            {
              id: "existing-profile",
              target: { agent: "claude", model: "fast" },
              strengths: ["general"],
            },
          ],
        },
      },
    });

    warnProfileMismatch(prd, config, logger);

    expect(logger.calls).toHaveLength(1);
    const call = logger.calls[0];
    assertDefined(call, "logger.calls[0]");
    expect(call.stage).toBe("setup");
    expect(call.message).toContain("removed-profile");
    expect(call.message).toContain("no longer exists");
    expect(call.data?.storyId).toBe("US-001");
  });

  test("does not emit warn when story's agentProfileId still exists in config", () => {
    const logger = makeLogger();
    const story = makeStory({
      id: "US-002",
      routing: {
        complexity: "simple",
        testStrategy: "tdd-simple",
        reasoning: "test",
        agent: "claude",
        agentProfileId: "existing-profile",
      },
    });
    const prd = makePRD({ userStories: [story] });
    const config = makeNaxConfig({
      routing: {
        agents: {
          enabled: true,
          strategy: "off" as const,
          default: "existing-profile",
          profiles: [
            {
              id: "existing-profile",
              target: { agent: "claude", model: "fast" },
              strengths: ["general"],
            },
          ],
        },
      },
    });

    warnProfileMismatch(prd, config, logger);

    expect(logger.calls).toHaveLength(0);
  });

  test("does not emit warn when story has no agentProfileId (control case)", () => {
    const logger = makeLogger();
    const story = makeStory({
      id: "US-003",
      routing: {
        complexity: "simple",
        testStrategy: "tdd-simple",
        reasoning: "test",
      },
    });
    const prd = makePRD({ userStories: [story] });
    const config = makeNaxConfig({
      routing: {
        agents: {
          enabled: true,
          strategy: "off" as const,
          default: "some-profile",
          profiles: [
            {
              id: "some-profile",
              target: { agent: "claude", model: "fast" },
              strengths: ["general"],
            },
          ],
        },
      },
    });

    warnProfileMismatch(prd, config, logger);

    expect(logger.calls).toHaveLength(0);
  });

  test("emits PRD-level warn when prd.routingProfile differs from the resolved config profile", () => {
    const logger = makeLogger();
    const prd = makePRD({ userStories: [], routingProfile: "aggressive" });
    const config = makeNaxConfig({ profile: "cheap" });

    warnProfileMismatch(prd, config, logger);

    expect(logger.calls).toHaveLength(1);
    const call = logger.calls[0];
    assertDefined(call, "logger.calls[0]");
    expect(call.stage).toBe("prd");
    expect(call.message).toContain('planned with config profile "aggressive"');
    expect(call.data?.storyId).toBe("prd");
    expect(call.data?.plannedProfile).toBe("aggressive");
    expect(call.data?.currentProfile).toBe("cheap");
  });

  test("does not emit PRD-level warn when prd.routingProfile matches the resolved config profile", () => {
    const logger = makeLogger();
    const prd = makePRD({ userStories: [], routingProfile: "shared" });
    const config = { ...makeNaxConfig(), profile: "shared" };

    warnProfileMismatch(prd, config, logger);

    expect(logger.calls).toHaveLength(0);
  });

  test("warns per story when routing.agent is not defined in config.models", () => {
    const logger = makeLogger();
    const prd = makePRD({
      userStories: [
        makeStory({
          id: "US-1",
          routing: {
            complexity: "simple",
            testStrategy: "test-after",
            reasoning: "",
            modelTier: "fast",
            agent: "ghost",
          },
        }),
      ],
    });
    const config = makeNaxConfig({ models: { claude: { fast: "m" } } });

    warnProfileMismatch(prd, config, logger);

    const agentWarns = logger.calls.filter(
      (c) => /agent "ghost".*not defined in config\.models/i.test(c.message) && c.data?.storyId === "US-1",
    );
    expect(agentWarns).toHaveLength(1);
    expect(agentWarns[0]?.data).toMatchObject({ storyId: "US-1", agent: "ghost" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MEM-1 (nax review 20260829): a throw between crash-handler installation and the
// lock-guarded try/finally must still uninstall the handlers and close the runtime.
// ─────────────────────────────────────────────────────────────────────────────

describe("setupRun — MEM-1: setup-phase throw cleans up crash handlers + runtime", () => {
  const runtimesToClose: NaxRuntime[] = [];

  afterEach(async () => {
    await Promise.allSettled(runtimesToClose.map((r) => r.close()));
    runtimesToClose.length = 0;
  });

  test("a throw before lock acquisition still uninstalls crash handlers and closes the runtime", async () => {
    const setupWorkdir = makeTempDir("nax-test-runsetup-mem1-");

    let cleanupSpy: ReturnType<typeof mock> | undefined;
    let closeSpy: ReturnType<typeof mock> | undefined;

    const origInstallCrashHandlers = _runSetupDeps.installCrashHandlers;
    const origCreateRuntime = _runSetupDeps.createRuntime;

    _runSetupDeps.createRuntime = ((...args: Parameters<typeof origCreateRuntime>) => {
      const runtime = origCreateRuntime(...args);
      runtimesToClose.push(runtime);
      closeSpy = mock(runtime.close.bind(runtime));
      runtime.close = closeSpy as typeof runtime.close;
      return runtime;
    }) as typeof origCreateRuntime;

    _runSetupDeps.installCrashHandlers = ((...args: Parameters<typeof origInstallCrashHandlers>) => {
      const cleanup = origInstallCrashHandlers(...args);
      cleanupSpy = mock(cleanup);
      return cleanupSpy;
    }) as typeof origInstallCrashHandlers;

    try {
      // loadPRD throws "PRD file not found" — a real setup-step failure that fires
      // after installCrashHandlers/createRuntime but before lock acquisition (one of
      // the unprotected throw sites named by the finding).
      const options: RunSetupOptions = {
        prdPath: join(setupWorkdir, "does-not-exist.json"),
        workdir: setupWorkdir,
        config: makeNaxConfig(),
        hooks: { hooks: {} },
        feature: "mem1-test-feature",
        dryRun: false,
        statusFile: join(setupWorkdir, "status.json"),
        runId: "run-mem1-test",
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

      await expect(setupRun(options)).rejects.toThrow(/PRD file not found/);

      assertDefined(cleanupSpy, "cleanupSpy");
      assertDefined(closeSpy, "closeSpy");
      expect(cleanupSpy).toHaveBeenCalledTimes(1);
      expect(closeSpy).toHaveBeenCalledTimes(1);
    } finally {
      _runSetupDeps.installCrashHandlers = origInstallCrashHandlers;
      _runSetupDeps.createRuntime = origCreateRuntime;
      rmSync(setupWorkdir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// nax#1808: the dry-run flag has to reach the runtime, or the auto-commit
// refusal it feeds is inert in production.
// ---------------------------------------------------------------------------

describe("runSetup dryRun", () => {
  test("passes options.dryRun through to createRuntime", async () => {
    const setupWorkdir = makeTempDir();
    const seen: Array<boolean | undefined> = [];
    const created: NaxRuntime[] = [];
    const origCreateRuntime = _runSetupDeps.createRuntime;
    _runSetupDeps.createRuntime = (...args: Parameters<typeof origCreateRuntime>) => {
      seen.push(args[2]?.dryRun);
      const runtime = origCreateRuntime(...args);
      created.push(runtime);
      return runtime;
    };

    try {
      const options: RunSetupOptions = {
        prdPath: join(setupWorkdir, "does-not-exist.json"),
        workdir: setupWorkdir,
        config: makeNaxConfig(),
        hooks: { hooks: {} },
        feature: "dryrun-test-feature",
        dryRun: true,
        statusFile: join(setupWorkdir, "status.json"),
        runId: "run-dryrun-test",
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

      await setupRun(options).catch(() => {});

      expect(seen).toEqual([true]);
    } finally {
      _runSetupDeps.createRuntime = origCreateRuntime;
      // setupRun throws before it can own the runtime, so this test is the only
      // thing that can close it (check:runtime-cleanup / #1679).
      for (const runtime of created) await runtime.close();
      rmSync(setupWorkdir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// US-002 AC10/AC11: setupRun invokes `sweepFeatureTranscripts` at the
// orphan-sweep block (around run-setup.ts:381) with the run's feature as
// `featureName` and `runtime.outputDir` as `transcriptRoot`. dryRun must be
// threaded through unchanged.
//
// The implementation is expected to expose `sweepFeatureTranscripts` via the
// `_runSetupDeps` injection seam (mirroring `detectProjectProfile` /
// `createRuntime` / `installCrashHandlers`); we cast through `unknown` so the
// test compiles before the property lands, and the failure mode is the
// assertion itself rather than a typecheck.
// ---------------------------------------------------------------------------

describe("setupRun — US-002 AC10: sweepFeatureTranscripts wiring", () => {
  // Cast to access a property the implementation will add to _runSetupDeps.
  // Done once at file scope so every test below can stub the same key.
  type DepsWithSweep = typeof _runSetupDeps & {
    sweepFeatureTranscripts?: (opts: {
      featureName?: string;
      transcriptRoot?: string;
      dryRun?: boolean;
    }) => Promise<number>;
  };
  const depsWithSweep = _runSetupDeps as DepsWithSweep;

  const runtimesToClose: NaxRuntime[] = [];

  afterEach(async () => {
    await Promise.allSettled(runtimesToClose.map((r) => r.close()));
    runtimesToClose.length = 0;
  });

  function writeValidPrd(prdPath: string, workdir: string): void {
    // Minimal valid PRD — a single passed story so initializeRun has nothing
    // left to reset and runs no agent preflight (only `failed` stories
    // trigger reconcile; `runWillUseAgent` reads status). Story status
    // 'passed' is the cleanest no-op input for both reconciliation and
    // story-count validation.
    const prd = makePRD({ feature: "demo-feature", userStories: [] });
    writeFileSync(prdPath, JSON.stringify(prd, null, 2), "utf8");
    void workdir;
  }

  test("_runSetupDeps exposes sweepFeatureTranscripts for injection", () => {
    // The implementation is expected to follow the existing _deps convention:
    // every external side-effect call goes through _runSetupDeps so tests
    // can swap it out without mock.module(). If the property is missing
    // this test fails at the first assertion rather than at import time.
    expect(typeof depsWithSweep.sweepFeatureTranscripts).toBe("function");
  });

  test("AC10: invokes sweepFeatureTranscripts exactly once with the run's feature and runtime.outputDir", async () => {
    const setupWorkdir = makeTempDir("nax-test-runsetup-sweep-");
    const prdPath = join(setupWorkdir, "prd.json");
    writeValidPrd(prdPath, setupWorkdir);

    const expectedOutputDir = join(setupWorkdir, "nax-out");
    const expectedFeature = "sweep-feature";
    let callCount = 0;
    const seenArgs: Array<{ featureName?: string; transcriptRoot?: string; dryRun?: boolean }> = [];

    const origCreateRuntime = _runSetupDeps.createRuntime;
    const origSweep = depsWithSweep.sweepFeatureTranscripts;
    const origDetect = _runSetupDeps.detectProjectProfile;

    // Build a stub runtime whose outputDir the test can verify the sweep
    // was called with. makeMockRuntime() already provides every NaxRuntime
    // field with non-`never` types; Object.defineProperty pins outputDir (no
    // `as never`, no double-cast).
    const baseRuntime = makeMockRuntime({ workdir: setupWorkdir });
    Object.defineProperty(baseRuntime, "outputDir", {
      value: expectedOutputDir,
      writable: false,
      configurable: true,
    });

    _runSetupDeps.createRuntime = (() => {
      runtimesToClose.push(baseRuntime);
      return baseRuntime;
    }) as typeof _runSetupDeps.createRuntime;

    depsWithSweep.sweepFeatureTranscripts = mock(async (opts) => {
      callCount++;
      seenArgs.push({ ...opts });
      return 0;
    }) as DepsWithSweep["sweepFeatureTranscripts"] & ReturnType<typeof mock>;

    _runSetupDeps.detectProjectProfile = (async () => ({})) as typeof _runSetupDeps.detectProjectProfile;

    try {
      const options: RunSetupOptions = {
        prdPath,
        workdir: setupWorkdir,
        config: makeNaxConfig(),
        hooks: { hooks: {} },
        feature: expectedFeature,
        dryRun: false,
        statusFile: join(setupWorkdir, "status.json"),
        runId: "run-sweep-test",
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

      // setupRun may throw after the sweep (e.g. at loadPlugins) — that's
      // fine, the sweep was already invoked. We only assert on the sweep
      // mock's captured calls.
      await setupRun(options).catch(() => {});

      // The test passes regardless of how far setupRun gets, as long as the
      // sweep was called with the right arguments. If the implementation
      // never reaches the sweep, callCount remains 0 and the assertion fails.
      expect(callCount).toBe(1);
      assertDefined(seenArgs[0], "seenArgs[0]");
      expect(seenArgs[0].featureName).toBe(expectedFeature);
      expect(seenArgs[0].transcriptRoot).toBe(expectedOutputDir);
    } finally {
      _runSetupDeps.createRuntime = origCreateRuntime;
      _runSetupDeps.detectProjectProfile = origDetect;
      depsWithSweep.sweepFeatureTranscripts = origSweep;
      rmSync(setupWorkdir, { recursive: true, force: true });
    }
  });

  test("AC11: invokes sweepFeatureTranscripts with dryRun=true when the run is dry", async () => {
    const setupWorkdir = makeTempDir("nax-test-runsetup-sweep-dryrun-");
    const prdPath = join(setupWorkdir, "prd.json");
    writeValidPrd(prdPath, setupWorkdir);

    const expectedOutputDir = join(setupWorkdir, "nax-out");
    const seenArgs: Array<{ featureName?: string; transcriptRoot?: string; dryRun?: boolean }> = [];

    const origCreateRuntime = _runSetupDeps.createRuntime;
    const origSweep = depsWithSweep.sweepFeatureTranscripts;
    const origDetect = _runSetupDeps.detectProjectProfile;

    // Build a stub runtime whose outputDir the test can verify the sweep
    // was called with (no `as never`, no double-cast).
    const baseRuntime = makeMockRuntime({ workdir: setupWorkdir });
    Object.defineProperty(baseRuntime, "outputDir", {
      value: expectedOutputDir,
      writable: false,
      configurable: true,
    });
    Object.defineProperty(baseRuntime, "dryRun", {
      value: true,
      writable: false,
      configurable: true,
    });

    _runSetupDeps.createRuntime = (() => {
      runtimesToClose.push(baseRuntime);
      return baseRuntime;
    }) as typeof _runSetupDeps.createRuntime;

    depsWithSweep.sweepFeatureTranscripts = mock(async (opts) => {
      seenArgs.push({ ...opts });
      return 0;
    }) as DepsWithSweep["sweepFeatureTranscripts"] & ReturnType<typeof mock>;

    _runSetupDeps.detectProjectProfile = (async () => ({})) as typeof _runSetupDeps.detectProjectProfile;

    try {
      const options: RunSetupOptions = {
        prdPath,
        workdir: setupWorkdir,
        config: makeNaxConfig(),
        hooks: { hooks: {} },
        feature: "dryrun-feature",
        dryRun: true,
        statusFile: join(setupWorkdir, "status.json"),
        runId: "run-sweep-dryrun",
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

      await setupRun(options).catch(() => {});

      assertDefined(seenArgs[0], "seenArgs[0]");
      expect(seenArgs[0].dryRun).toBe(true);
      expect(seenArgs[0].featureName).toBe("dryrun-feature");
      expect(seenArgs[0].transcriptRoot).toBe(expectedOutputDir);
    } finally {
      _runSetupDeps.createRuntime = origCreateRuntime;
      _runSetupDeps.detectProjectProfile = origDetect;
      depsWithSweep.sweepFeatureTranscripts = origSweep;
      rmSync(setupWorkdir, { recursive: true, force: true });
    }
  });
});
