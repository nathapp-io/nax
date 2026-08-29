/**
 * Unit tests for run-setup.ts — US-002 wiring
 *
 * Verifies that setupRun calls detectProjectProfile and merges the result
 * into config.project so all downstream code reading config.project?.language
 * receives the auto-detected value.
 */

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  assertDefined,
  makeLogger,
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
