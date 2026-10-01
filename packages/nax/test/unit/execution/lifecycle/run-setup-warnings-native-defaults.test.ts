/**
 * Run-start guards for the native defaults (hybrid protocol, native default agent).
 *
 * Precheck is opt-in (NAX_PRECHECK=1), so anything a default `nax run` must
 * enforce lives on the always-on setup path:
 *  - `assertDefaultNativeCredentials` — setupRun refuses to start when a provider
 *    the default native tier map uses has no credential, before any billed call.
 *  - `warnUnreferencedAgentModels` — a declared acpx model map that no default,
 *    rung, pin or PRD story reaches is reported once at setup.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupTempDir,
  makeLogger,
  makeMockRuntime,
  makeNaxConfig,
  makePRD,
  makeStory,
  makeTempDir,
  withDepsRestore,
  withWarnSpy,
} from "@test/helpers";
import type { NaxConfig } from "@/config";
import { _runSetupDeps, type RunSetupOptions, setupRun } from "@/execution/lifecycle/run-setup";
import { warnUnreferencedAgentModels } from "@/execution/lifecycle/run-setup-warnings";
import { _nativeCredentialDeps } from "@/precheck";
import type { NaxRuntime } from "@/runtime";

const CLAUDE_MAP = { fast: "haiku", balanced: "sonnet[medium]", powerful: "opus" };

describe("warnUnreferencedAgentModels", () => {
  test("warns once, naming the map, with the _setup storyId", () => {
    const logger = makeLogger();
    warnUnreferencedAgentModels(
      makePRD({ userStories: [] }),
      makeNaxConfig({ models: { claude: CLAUDE_MAP } }),
      logger,
    );
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [stage, message, data] = logger.warn.mock.calls[0] ?? [];
    expect(stage).toBe("config");
    expect(message).toContain("models.claude");
    expect(data).toMatchObject({ storyId: "_setup", agents: ["claude"] });
  });

  test("stays silent when a PRD story routes to the agent", () => {
    const logger = makeLogger();
    const prd = makePRD({
      userStories: [
        makeStory({
          routing: { complexity: "simple", testStrategy: "tdd-simple", reasoning: "test", agent: "claude" },
        }),
      ],
    });
    warnUnreferencedAgentModels(prd, makeNaxConfig({ models: { claude: CLAUDE_MAP } }), logger);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe("setupRun — native-default guards", () => {
  withDepsRestore(_runSetupDeps, [
    "createRuntime",
    "detectProjectProfile",
    "sweepFeatureTranscripts",
    "installCrashHandlers",
  ]);
  withDepsRestore(_nativeCredentialDeps, ["providersWithoutCredentials"]);

  const runtimesToClose: NaxRuntime[] = [];
  const workdirsToRemove: string[] = [];

  afterEach(async () => {
    await Promise.allSettled(runtimesToClose.map((runtime) => runtime.close()));
    runtimesToClose.length = 0;
    for (const workdir of workdirsToRemove) cleanupTempDir(workdir);
    workdirsToRemove.length = 0;
  });

  function installHarness(): { workdir: string; prdPath: string } {
    const workdir = makeTempDir("nax-test-native-defaults-");
    workdirsToRemove.push(workdir);
    const runtime = makeMockRuntime({ workdir });
    runtimesToClose.push(runtime);
    _runSetupDeps.createRuntime = () => runtime;
    _runSetupDeps.detectProjectProfile = async () => ({});
    _runSetupDeps.sweepFeatureTranscripts = async () => 0;
    _runSetupDeps.installCrashHandlers = () => () => undefined;
    const prdPath = join(workdir, "prd.json");
    writeFileSync(prdPath, JSON.stringify(makePRD({ feature: "native-defaults", userStories: [] }), null, 2), "utf8");
    return { workdir, prdPath };
  }

  function makeOptions(workdir: string, prdPath: string, config: NaxConfig, dryRun = false): RunSetupOptions {
    return {
      prdPath,
      workdir,
      config,
      hooks: { hooks: {} },
      feature: "native-defaults",
      dryRun,
      statusFile: join(workdir, "status.json"),
      runId: `run-native-defaults-${Date.now()}`,
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
  }

  test("refuses to start when the default native map's provider has no credential", async () => {
    const { workdir, prdPath } = installHarness();
    _nativeCredentialDeps.providersWithoutCredentials = mock(async () => ["anthropic"]);
    const config = makeNaxConfig({ acceptance: { enabled: false } });

    const error = await setupRun(makeOptions(workdir, prdPath, config)).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "NATIVE_CREDENTIALS_MISSING",
      message: expect.stringContaining("nax auth login anthropic"),
    });
  });

  test("a dry run makes no billed call, so it is not refused", async () => {
    const { workdir, prdPath } = installHarness();
    const probe = mock(async () => ["anthropic"]);
    _nativeCredentialDeps.providersWithoutCredentials = probe;
    const config = makeNaxConfig({ acceptance: { enabled: false } });

    const error = await setupRun(makeOptions(workdir, prdPath, config, true)).catch((caught: unknown) => caught);

    expect(error).not.toMatchObject({ code: "NATIVE_CREDENTIALS_MISSING" });
    expect(probe).not.toHaveBeenCalled();
  });

  test("emits the unreferenced-model warning at run start", async () => {
    const { workdir, prdPath } = installHarness();
    const config = makeNaxConfig({ models: { claude: CLAUDE_MAP }, acceptance: { enabled: false } });

    await withWarnSpy(async (warnSpy) => {
      await setupRun(makeOptions(workdir, prdPath, config)).catch(() => {});
      const warning = warnSpy.mock.calls.find((call) => call[0] === "config" && call[2]?.agents !== undefined);
      expect(warning?.[2]).toMatchObject({ storyId: "_setup", agents: ["claude"] });
    });
  });
});
