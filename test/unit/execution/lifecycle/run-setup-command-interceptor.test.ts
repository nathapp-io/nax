import { afterEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeMockRuntime, makeNaxConfig, makePRD, makeSpawn, makeTempDir, withDepsRestore } from "@test/helpers";
import type { NaxConfig } from "@/config";
import type { RtkDeps } from "@/execution/interceptors/rtk";
import { createRtkInterceptor } from "@/execution/interceptors/rtk";
import { _runSetupDeps, type RunSetupOptions, setupRun } from "@/execution/lifecycle/run-setup";
import { _gitToolDeps, gitTool } from "@/tools/git";
import { _gitDeps } from "@/utils/git";

const ctx = () => ({ root: "/repo", resolvedPaths: [], maxBytes: 4096, maxFileBytes: 1024 });

/** The exact install setupRun performs (run-setup.ts), with `_deps` injected so no real rtk binary is consulted. */
function installFromConfig(config: NaxConfig, deps: Partial<RtkDeps>): void {
  const ci = config.execution.commandInterceptor;
  _gitToolDeps.interceptor = createRtkInterceptor({
    enabled: ci.enabled,
    verbs: ci.git.verbs,
    _deps: deps,
  });
}

describe("setupRun → command interceptor composition (config → provider → Git tool)", () => {
  withDepsRestore(_gitToolDeps, ["interceptor"]);
  withDepsRestore(_gitDeps, ["spawn"]);
  withDepsRestore(_runSetupDeps);

  const createdRuntimes: ReturnType<typeof makeMockRuntime>[] = [];
  afterEach(async () => {
    await Promise.allSettled(createdRuntimes.map((r) => r.close()));
    createdRuntimes.length = 0;
  });

  /** Drive the REAL setupRun, mirroring run-setup.test.ts's sweep fixture. */
  async function driveSetupRun(workdir: string, config: NaxConfig): Promise<void> {
    const prdPath = join(workdir, "prd.json");
    writeFileSync(prdPath, JSON.stringify(makePRD({ feature: "ci-drive", userStories: [] }), null, 2), "utf8");
    _runSetupDeps.createRuntime = (() => {
      const rt = makeMockRuntime({ workdir });
      createdRuntimes.push(rt);
      return rt;
    }) as typeof _runSetupDeps.createRuntime;
    _runSetupDeps.installCrashHandlers = (() => () => {}) as typeof _runSetupDeps.installCrashHandlers;
    _runSetupDeps.detectProjectProfile = (async () => ({})) as typeof _runSetupDeps.detectProjectProfile;

    const options: RunSetupOptions = {
      prdPath,
      workdir,
      config,
      hooks: { hooks: {} },
      feature: "ci-drive",
      dryRun: false,
      statusFile: join(workdir, "status.json"),
      runId: `run-ci-${Date.now()}`,
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
    // setupRun may throw at a later step (loadPlugins, initializeRun); the
    // interceptor install is the first config-dependent step, so the assertion
    // below holds regardless of how far setupRun gets.
    await setupRun(options).catch(() => {});
  }

  test("with enabled: false no rewrite occurs", async () => {
    const calls: string[][] = [];
    _gitDeps.spawn = makeSpawn(({ cmd }) => {
      calls.push([...cmd]);
      return "out";
    }).spawn;

    installFromConfig(makeNaxConfig({ execution: { commandInterceptor: { enabled: false } } }), {
      which: () => "/usr/bin/rtk",
      version: () => "0.45.0",
      record: () => {},
    });

    const result = await gitTool.run({ subcommand: "log" }, ctx());

    expect(result.isError).toBeFalsy();
    expect(calls[0]?.[0]).toBe("git");
    expect(result.audit).toBeUndefined();
  });

  test("with enabled: true and rtk absent every command still succeeds unchanged", async () => {
    const calls: string[][] = [];
    _gitDeps.spawn = makeSpawn(({ cmd }) => {
      calls.push([...cmd]);
      return "out";
    }).spawn;

    installFromConfig(makeNaxConfig({ execution: { commandInterceptor: { enabled: true } } }), {
      which: () => null,
      version: () => null,
      record: () => {},
    });

    // The provider really is installed, and the configured verbs match — the
    // interceptor declines only because the preflight probe found no binary.
    expect(_gitToolDeps.interceptor?.provider).toBe("rtk");
    const outcome = await _gitToolDeps.interceptor?.intercept({
      kind: "argv",
      argv: ["git", "diff"],
      cwd: "/repo",
      site: "git",
    });
    expect(outcome?.kind).toBe("declined");

    const result = await gitTool.run({ subcommand: "diff" }, ctx());

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("out");
    expect(calls[0]?.[0]).toBe("git");
    expect(result.audit).toBeUndefined();
  });

  test("a real setupRun installs the interceptor reflecting enabled: false", async () => {
    const workdir = makeTempDir("nax-test-runsetup-ci-");
    try {
      await driveSetupRun(workdir, makeNaxConfig({ execution: { commandInterceptor: { enabled: false } } }));

      expect(_gitToolDeps.interceptor?.provider).toBe("rtk");
      const outcome = await _gitToolDeps.interceptor?.intercept({
        kind: "argv",
        argv: ["git", "log"],
        cwd: workdir,
        site: "git",
      });
      expect(outcome?.kind).toBe("unchanged");
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  test("a real setupRun installs the interceptor reflecting enabled: true", async () => {
    const workdir = makeTempDir("nax-test-runsetup-ci-");
    try {
      await driveSetupRun(workdir, makeNaxConfig({ execution: { commandInterceptor: { enabled: true } } }));

      expect(_gitToolDeps.interceptor?.provider).toBe("rtk");
      // enabled: true probes the real binary at construction; rtk may or may
      // not be installed on this machine, so a configured verb resolves to
      // rewritten (present) or declined (absent) — never unchanged.
      const outcome = await _gitToolDeps.interceptor?.intercept({
        kind: "argv",
        argv: ["git", "log"],
        cwd: workdir,
        site: "git",
      });
      expect(outcome?.kind).not.toBe("unchanged");
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });
});
