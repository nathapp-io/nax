import { afterEach, describe, expect, test } from "bun:test";
import type { NaxConfig } from "@/config";
import { DEFAULT_CONFIG } from "@/config";
import type { FinishPhaseState, GateRunRecord, GateRunStatus } from "@/finish";
import {
  _qualityGateDeps,
  classifyGateExit,
  GATE_ORDER,
  gateOutputTail,
  resolveGateCommands,
  routeQualityGates,
  runQualityGates,
} from "@/finish";
import type { QualityCommandResult } from "@/quality";

const original = { ..._qualityGateDeps };
afterEach(() => {
  _qualityGateDeps.run = original.run;
  _qualityGateDeps.loadConfig = original.loadConfig;
  _qualityGateDeps.loadPackageOverride = original.loadPackageOverride;
});

const zeroedState = (): FinishPhaseState => ({
  fixAttempts: 0,
  reviewAttempts: 0,
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
  test.each([{ lint: "" }, { lint: "   " }, { lint: ["  "] }, { lint: [] }])(
    "US-007 AC10-11: blank command %j produces no gate",
    async ({ lint }) => {
      _qualityGateDeps.loadConfig = async () =>
        configWithCommands({ lint: typeof lint === "string" ? lint : [...lint] });
      expect(await resolveGateCommands("/repo", [])).toEqual([]);
    },
  );

  test.each([undefined, "package setup"])("US-007 AC12-13: e2e setup layering %s", async (setup) => {
    _qualityGateDeps.loadConfig = async () => configWithCommands({ e2eSetup: "root setup" });
    _qualityGateDeps.loadPackageOverride = async () => ({
      quality: {
        ...DEFAULT_CONFIG.quality,
        commands: { e2e: "journey", ...(setup === undefined ? {} : { e2eSetup: setup }) },
      },
    });
    expect(await resolveGateCommands("/repo", ["pkg"])).toEqual([
      { name: "e2e@pkg", command: "journey", cwd: "/repo/pkg", setup: setup ?? "root setup" },
    ]);
  });
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

  test("review B1: two root gate keys with the same command string are two gates", async () => {
    // `build` and `typecheck` both running `tsc --noEmit` is a real config. The
    // dedupe used to key on (cwd, command, setup) alone, so `typecheck`
    // vanished -- and `nax gates run --gate typecheck` then answered "gate
    // typecheck is not configured" for a gate the config sets.
    _qualityGateDeps.loadConfig = async () => configWithCommands({ build: "tsc --noEmit", typecheck: "tsc --noEmit" });
    _qualityGateDeps.loadPackageOverride = async () => null;

    expect(await resolveGateCommands("/repo", [])).toEqual([
      { name: "build", command: "tsc --noEmit", cwd: "/repo" },
      { name: "typecheck", command: "tsc --noEmit", cwd: "/repo" },
    ]);
  });

  test("review B1: an overlay gate whose key differs from the root gate sharing its command is kept", async () => {
    _qualityGateDeps.loadConfig = async () => configWithCommands({ build: "tsc --noEmit" });
    _qualityGateDeps.loadPackageOverride = async () => ({
      quality: { ...DEFAULT_CONFIG.quality, commands: { typecheck: "tsc --noEmit" } },
    });

    // Two *different* gate keys are two gates whatever their command strings
    // say; only a repeat of the same gate key from the same cwd with the same
    // command and setup is the same run.
    const commands = await resolveGateCommands("/repo", ["."]);

    expect(commands.map((c) => c.name)).toEqual(["build", "typecheck@."]);
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

  test("routeQualityGates stops when nothing ran (I1)", async () => {
    const result = await runQualityGates("/repo", []);
    const routed = routeQualityGates(result, zeroedState());
    expect(routed.route).toBe("stop");
  });

  test("all four gates run even after the first one fails, and `failing` lists both red gates", async () => {
    const calls: string[] = [];
    _qualityGateDeps.run = async (opts) => {
      calls.push(opts.commandName);
      const failed = opts.commandName === "build" || opts.commandName === "test";
      return {
        commandName: opts.commandName,
        command: opts.command as string,
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
      command: opts.command as string,
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
        command: opts.command as string,
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

// ---------------------------------------------------------------------------
// US-001 — per-gate run records
// ---------------------------------------------------------------------------

/** A `_qualityGateDeps.run` result for `commandName`. */
function stubResult(
  commandName: string,
  exitCode: number,
  output: string,
  durationMs = 7,
  timedOut = false,
): QualityCommandResult {
  return {
    commandName,
    command: "cmd",
    success: exitCode === 0,
    exitCode,
    output,
    durationMs,
    timedOut,
  };
}

/** The three gates AC-9..AC-12 stub: pass, "not found" (127), real failure (1). */
const STUBBED_GATES = [
  { name: "build", command: "cmd", cwd: "/repo", exitCode: 0, output: "build ok", durationMs: 11 },
  { name: "lint", command: "cmd", cwd: "/repo", exitCode: 127, output: "lint: command not found", durationMs: 12 },
  { name: "test", command: "cmd", cwd: "/repo", exitCode: 1, output: "2 tests failed", durationMs: 13 },
];

/** Stub `_qualityGateDeps.run` with `STUBBED_GATES`. */
function stubStubbedGates(): void {
  _qualityGateDeps.run = async (opts) => {
    const gate = STUBBED_GATES.find((g) => g.name === opts.commandName);
    if (gate === undefined) throw new Error(`unexpected gate ${opts.commandName}`);
    return stubResult(gate.name, gate.exitCode, gate.output, gate.durationMs);
  };
}

describe("classifyGateExit", () => {
  const CASES: { exitCode: number; timedOut: boolean; expected: GateRunStatus }[] = [
    { exitCode: 0, timedOut: false, expected: "passed" },
    { exitCode: 1, timedOut: false, expected: "failed" },
    { exitCode: 2, timedOut: false, expected: "failed" },
    { exitCode: 127, timedOut: false, expected: "not-run" },
    { exitCode: 126, timedOut: false, expected: "not-run" },
    { exitCode: -1, timedOut: false, expected: "not-run" },
    { exitCode: -1, timedOut: true, expected: "timed-out" },
    { exitCode: 0, timedOut: true, expected: "timed-out" },
  ];

  test.each(CASES)(
    "US-001 AC-1..8: exit=$exitCode timedOut=$timedOut -> $expected",
    ({ exitCode, timedOut, expected }) => {
      expect(classifyGateExit({ exitCode, timedOut })).toBe(expected);
    },
  );

  test("US-001 AC-18: the barrel's classifyGateExit classifies 127 as not-run", async () => {
    const barrel = await import("@/finish");
    expect(barrel.classifyGateExit({ exitCode: 127, timedOut: false })).toBe("not-run");
  });
});

describe("gateOutputTail", () => {
  const hundred = Array.from({ length: 100 }, (_, i) => `line${i + 1}`).join("\n");

  test("US-001 AC-19: 100 lines with a trailing newline -> the last 40, no trailing newline", () => {
    const tail = gateOutputTail(`${hundred}\n`);
    expect(tail.split("\n")).toHaveLength(40);
    expect(tail.startsWith("line61\n")).toBe(true);
    expect(tail.endsWith("line100")).toBe(true);
  });

  test("US-001 AC-20: whitespace-only and empty output gives the empty string", () => {
    expect(gateOutputTail("")).toBe("");
    expect(gateOutputTail("\n\n")).toBe("");
  });

  test("an explicit line count keeps only that many lines, and short output is returned whole", () => {
    expect(gateOutputTail(`${hundred}\n`, 2)).toBe("line99\nline100");
    expect(gateOutputTail("only one line\n")).toBe("only one line");
  });
});

describe("GATE_ORDER", () => {
  test("US-001 AC-21: the barrel exports the gate order", () => {
    expect(GATE_ORDER).toEqual(["build", "typecheck", "lint", "test", "e2e"]);
  });
});

describe("runQualityGates — onGate", () => {
  test("US-001 AC-9 + AC-10: one record per gate, in run order, with that gate's result", async () => {
    stubStubbedGates();
    const records: GateRunRecord[] = [];

    await runQualityGates("/repo", STUBBED_GATES, { onGate: (record) => records.push(record) });

    expect(records.map((r) => r.name)).toEqual(["build", "lint", "test"]);
    expect(records.map((r) => r.status)).toEqual(["passed", "not-run", "failed"]);
    expect(records).toEqual([
      { name: "build", cwd: "/repo", status: "passed", exitCode: 0, durationMs: 11, output: "build ok" },
      {
        name: "lint",
        cwd: "/repo",
        status: "not-run",
        exitCode: 127,
        durationMs: 12,
        output: "lint: command not found",
      },
      { name: "test", cwd: "/repo", status: "failed", exitCode: 1, durationMs: 13, output: "2 tests failed" },
    ]);
  });

  test("US-001 AC-12: the returned QualityGateResult is identical with and without onGate", async () => {
    stubStubbedGates();
    const without = await runQualityGates("/repo", STUBBED_GATES);

    stubStubbedGates();
    const withOnGate = await runQualityGates("/repo", STUBBED_GATES, { onGate: () => {} });

    expect(without).toEqual({
      passed: false,
      ran: ["build", "lint", "test"],
      failing: ["lint", "test"],
      output: expect.any(String),
    });
    expect(withOnGate).toEqual(without);
    expect(withOnGate.output).toBe(without.output);
  });

  test("US-001 AC-11: each record arrives before the next gate's command starts", async () => {
    const events: string[] = [];
    _qualityGateDeps.run = async (opts) => {
      events.push(`run:${opts.commandName}`);
      return stubResult(opts.commandName, 0, "ok");
    };
    const gates = [
      { name: "build", command: "cmd", cwd: "/repo" },
      { name: "test", command: "cmd", cwd: "/repo" },
    ];

    await runQualityGates("/repo", gates, { onGate: (record) => events.push(`onGate:${record.name}`) });

    expect(events).toEqual(["run:build", "onGate:build", "run:test", "onGate:test"]);
  });

  test("an onGate exception propagates and stops the later gates", async () => {
    const calls: string[] = [];
    _qualityGateDeps.run = async (opts) => {
      calls.push(opts.commandName);
      return stubResult(opts.commandName, 0, "ok");
    };
    const boom = new Error("onGate boom");
    const gates = [
      { name: "build", command: "cmd", cwd: "/repo" },
      { name: "test", command: "cmd", cwd: "/repo" },
    ];

    await expect(
      runQualityGates("/repo", gates, {
        onGate: () => {
          throw boom;
        },
      }),
    ).rejects.toBe(boom);
    expect(calls).toEqual(["build"]);
  });

  test("US-001 AC-13: a failed setup gives one e2e record from the setup result and never runs e2e", async () => {
    const calls: string[] = [];
    _qualityGateDeps.run = async (opts) => {
      calls.push(opts.commandName);
      return stubResult(opts.commandName, 1, "docker: command not found", 21);
    };
    const records: GateRunRecord[] = [];

    await runQualityGates(
      "/repo",
      [{ name: "e2e", command: "bunx playwright test", cwd: "/repo", setup: "docker compose up -d" }],
      { onGate: (record) => records.push(record) },
    );

    expect(calls).toEqual(["e2e:setup"]);
    expect(records).toEqual([
      {
        name: "e2e",
        cwd: "/repo",
        status: "failed",
        exitCode: 1,
        durationMs: 21,
        failedPhase: "setup",
        output: "docker: command not found",
      },
    ]);
  });

  test("US-001 AC-14: a setup the shell cannot execute reports not-run", async () => {
    _qualityGateDeps.run = async (opts) => stubResult(opts.commandName, 127, "docker: command not found");
    const records: GateRunRecord[] = [];

    await runQualityGates(
      "/repo",
      [{ name: "e2e", command: "bunx playwright test", cwd: "/repo", setup: "docker compose up -d" }],
      { onGate: (record) => records.push(record) },
    );

    expect(records).toHaveLength(1);
    expect(records[0]?.status).toBe("not-run");
    expect(records[0]?.failedPhase).toBe("setup");
  });

  test("US-001 AC-15: a passing setup followed by a green command gives a record with no failedPhase", async () => {
    _qualityGateDeps.run = async (opts) => stubResult(opts.commandName, 0, "ok", 5);
    const records: GateRunRecord[] = [];

    await runQualityGates(
      "/repo",
      [{ name: "e2e", command: "bunx playwright test", cwd: "/repo", setup: "docker compose up -d" }],
      { onGate: (record) => records.push(record) },
    );

    const [record] = records;
    expect(record).toEqual({
      name: "e2e",
      cwd: "/repo",
      status: "passed",
      exitCode: 0,
      durationMs: 5,
      output: "ok",
    });
    expect(Object.hasOwn(record ?? {}, "failedPhase")).toBe(false);
  });

  test("US-001 AC-16: a timed-out gate reports timed-out with exit code -1", async () => {
    _qualityGateDeps.run = async (opts) => stubResult(opts.commandName, -1, "killed after 900s", 900_000, true);
    const records: GateRunRecord[] = [];

    await runQualityGates("/repo", [{ name: "test", command: "bun test", cwd: "/repo" }], {
      onGate: (record) => records.push(record),
    });

    expect(records[0]?.status).toBe("timed-out");
    expect(records[0]?.exitCode).toBe(-1);
  });

  test("US-001 AC-17: no gates configured calls onGate zero times and still fails", async () => {
    let calls = 0;

    const result = await runQualityGates("/repo", [], {
      onGate: () => {
        calls += 1;
      },
    });

    expect(calls).toBe(0);
    expect(result.passed).toBe(false);
    expect(result.ran).toEqual([]);
  });
});
