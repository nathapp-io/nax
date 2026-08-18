import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "@/config";
import type { NaxConfig } from "@/config";
import { _qualityGateDeps, resolveGateCommands, routeQualityGates, runQualityGates } from "@/finish";
import type { FinishPhaseState } from "@/finish";

const original = { ..._qualityGateDeps };
afterEach(() => {
  _qualityGateDeps.run = original.run;
  _qualityGateDeps.loadConfig = original.loadConfig;
  _qualityGateDeps.loadPackageOverride = original.loadPackageOverride;
});

const zeroedState = (): FinishPhaseState => ({
  fixAttempts: 0,
  reviewAttempts: 0,
  incompleteAttempts: 0,
  rounds: 0,
});

/** A full NaxConfig with `quality.commands` overridden -- avoids partial casts. */
function configWithCommands(commands: NaxConfig["quality"]["commands"]): NaxConfig {
  return {
    ...DEFAULT_CONFIG,
    quality: { ...DEFAULT_CONFIG.quality, commands },
  };
}

describe("resolveGateCommands", () => {
  test("F2 regression: no root quality.commands, but a package overlay sets `test` -- resolved and included", async () => {
    _qualityGateDeps.loadConfig = async () => configWithCommands({});
    _qualityGateDeps.loadPackageOverride = async (_repoRoot, packageDir) => {
      expect(packageDir).toBe("apps/web");
      return { quality: { ...DEFAULT_CONFIG.quality, commands: { test: "bun test apps/web" } } };
    };

    const commands = await resolveGateCommands("/repo", ["apps/web"]);

    expect(commands).toEqual([{ name: "test@apps/web", command: "bun test apps/web", cwd: "/repo/apps/web" }]);
  });

  test("a package overlay that sets only one gate does not fan out the root's other gates for that package", async () => {
    // Regression for the fan-out bug: root has all four gates configured, the
    // package overlay sets only `test`. Only `test@pkg` may appear -- picking
    // up build/typecheck/lint from a merged config would re-run them a second
    // time under the package's cwd.
    _qualityGateDeps.loadConfig = async () =>
      configWithCommands({ build: "root build", typecheck: "root typecheck", lint: "root lint", test: "root test" });
    _qualityGateDeps.loadPackageOverride = async (_repoRoot, packageDir) => {
      expect(packageDir).toBe("apps/web");
      return { quality: { ...DEFAULT_CONFIG.quality, commands: { test: "bun test apps/web" } } };
    };

    const commands = await resolveGateCommands("/repo", ["apps/web"]);

    expect(commands.map((c) => c.name)).toEqual(["build", "typecheck", "lint", "test", "test@apps/web"]);
  });

  test("a profile-layered root command is picked up (single-file read is gone)", async () => {
    _qualityGateDeps.loadConfig = async (startDir) => {
      expect(startDir).toBe("/repo");
      // Simulates a value only resolvable through the global+project+profile
      // chain -- a raw single-file read of .nax/config.json would not see it.
      return configWithCommands({ build: "profile-layered build cmd" });
    };
    _qualityGateDeps.loadPackageOverride = async () => null;

    const commands = await resolveGateCommands("/repo", []);

    expect(commands).toEqual([{ name: "build", command: "profile-layered build cmd", cwd: "/repo" }]);
  });

  test("a package overlay repeating the root command verbatim from the same directory is deduped", async () => {
    _qualityGateDeps.loadConfig = async () => configWithCommands({ build: "echo root" });
    _qualityGateDeps.loadPackageOverride = async (_repoRoot, packageDir) => {
      if (packageDir !== ".") return null;
      return { quality: { ...DEFAULT_CONFIG.quality, commands: { build: "echo root" } } };
    };

    // packageDir "." resolves to the same cwd as the root ("/repo/." === "/repo"),
    // and repeats the root's exact command -- must collapse to one gate.
    const commands = await resolveGateCommands("/repo", ["."]);

    expect(commands).toEqual([{ name: "build", command: "echo root", cwd: "/repo" }]);
  });

  test("filters out the empty-string package dir -- the root package is the root run", async () => {
    _qualityGateDeps.loadConfig = async () => configWithCommands({ lint: "biome lint" });
    _qualityGateDeps.loadPackageOverride = async () => {
      throw new Error("loadPackageOverride must not be called for the '' package dir");
    };

    const commands = await resolveGateCommands("/repo", [""]);

    expect(commands).toEqual([{ name: "lint", command: "biome lint", cwd: "/repo" }]);
  });

  test("a package that merely inherits root commands (no own quality.commands) is not fanned out", async () => {
    _qualityGateDeps.loadConfig = async () => configWithCommands({ test: "bun test" });
    _qualityGateDeps.loadPackageOverride = async () => null;

    const commands = await resolveGateCommands("/repo", ["apps/inherits-only"]);

    expect(commands).toEqual([{ name: "test", command: "bun test", cwd: "/repo" }]);
  });

  test("orders root gates by GATE_ORDER, then each package's gates by GATE_ORDER, packages in order given", async () => {
    _qualityGateDeps.loadConfig = async () =>
      configWithCommands({ test: "root test", build: "root build", typecheck: "root typecheck" });
    _qualityGateDeps.loadPackageOverride = async (_repoRoot, packageDir) => ({
      quality: {
        ...DEFAULT_CONFIG.quality,
        commands: { lint: `lint@${packageDir}`, build: `build@${packageDir}` },
      },
    });

    const commands = await resolveGateCommands("/repo", ["pkg-b", "pkg-a"]);

    expect(commands.map((c) => c.name)).toEqual([
      "build",
      "typecheck",
      "test",
      "build@pkg-b",
      "lint@pkg-b",
      "build@pkg-a",
      "lint@pkg-a",
    ]);
  });
});

describe("runQualityGates", () => {
  test("nothing configured is not a pass: empty command list yields passed:false, ran:[]", async () => {
    const result = await runQualityGates("/repo", []);
    expect(result).toEqual({
      passed: false,
      ran: [],
      failing: [],
      output: expect.stringContaining("no quality.commands configured"),
    });
  });

  test("routeQualityGates escalates when nothing ran (I1)", async () => {
    const result = await runQualityGates("/repo", []);
    const routed = routeQualityGates(result, zeroedState());
    expect(routed.route).toBe("escalate");
  });

  test("all four gates run even after the first one fails, and `failing` lists both red gates", async () => {
    const calls: string[] = [];
    _qualityGateDeps.run = async (opts) => {
      calls.push(opts.commandName);
      const failed = opts.commandName === "build" || opts.commandName === "test";
      return {
        commandName: opts.commandName,
        command: opts.command,
        success: !failed,
        exitCode: failed ? 1 : 0,
        output: failed ? "boom" : "ok",
        durationMs: 1,
        timedOut: false,
      };
    };

    const commands = [
      { name: "build", command: "echo build", cwd: "/repo" },
      { name: "typecheck", command: "echo typecheck", cwd: "/repo" },
      { name: "lint", command: "echo lint", cwd: "/repo" },
      { name: "test", command: "echo test", cwd: "/repo" },
    ];
    const result = await runQualityGates("/repo", commands);

    expect(calls).toEqual(["build", "typecheck", "lint", "test"]);
    expect(result.passed).toBe(false);
    expect(result.ran).toEqual(["build", "typecheck", "lint", "test"]);
    expect(result.failing).toEqual(["build", "test"]);
  });

  test("all gates green: passed true, ran lists every gate, failing empty", async () => {
    _qualityGateDeps.run = async (opts) => ({
      commandName: opts.commandName,
      command: opts.command,
      success: true,
      exitCode: 0,
      output: "ok",
      durationMs: 1,
      timedOut: false,
    });

    const commands = [{ name: "lint", command: "echo lint", cwd: "/repo" }];
    const result = await runQualityGates("/repo", commands);

    expect(result).toEqual({ passed: true, ran: ["lint"], failing: [], output: expect.stringContaining("[lint]") });
  });

  test("spawns each command at its own cwd with the given timeout", async () => {
    const calls: { workdir: string; timeoutMs?: number }[] = [];
    _qualityGateDeps.run = async (opts) => {
      calls.push({ workdir: opts.workdir, timeoutMs: opts.timeoutMs });
      return {
        commandName: opts.commandName,
        command: opts.command,
        success: true,
        exitCode: 0,
        output: "",
        durationMs: 1,
        timedOut: false,
      };
    };

    await runQualityGates("/repo", [{ name: "test@apps/web", command: "bun test", cwd: "/repo/apps/web" }], {
      timeoutMs: 42,
    });

    expect(calls).toEqual([{ workdir: "/repo/apps/web", timeoutMs: 42 }]);
  });
});
