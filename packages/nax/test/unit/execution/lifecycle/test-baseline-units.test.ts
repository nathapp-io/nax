/**
 * Unit tests for `src/execution/lifecycle/test-baseline-units.ts` (US-004) and
 * for the per-package branch of `captureRunBaseline` it powers.
 *
 *   - AC1   every unit's command runs in its own `cmdWorkdir`, strings per entry
 *   - AC2   equal-valued commands run once
 *   - AC3   entries carry their package and the baseline records `packageDirs`
 *   - AC4   a shared command's failure is recorded for every package in the group
 *   - AC5   the root unit's entry has no `packageDir` key
 *   - AC6   a package with no test command is skipped and logged
 *   - AC7   a gate-disabled package is skipped, never run, and logged
 *   - AC8   every unit disabled → `gate-disabled`
 *   - AC9   one disabled + one commandless → `no-test-command`
 *   - AC10  a timeout stops the loop and names the package's command
 *   - AC11  distinct commands keep their own timeouts
 *   - AC12  a shared command runs with the largest of its timeouts
 *   - AC13  `"x"` and `["x"]` are the same command
 *   - AC14  a group naming no failure writes `unparseable` with its own evidence
 *   - AC15  `packageDirs: ["."]` keeps the root capture path
 *   - AC16  no registry keeps the root capture path
 *   - AC17  production `resolveUnit` reads the gate switch from the package config
 *   - AC18  production `resolveUnit` returns the package's resolved suite command
 *   - AC19  `runExecutionPhase` resolves the pending stories' packages, in order
 *   - AC20  a runner throw stops the loop and names the throwing command
 *   - AC21  a package skipped for no command is unattributed at the gate
 *
 * Posture: `_captureDeps` is stubbed throughout, so no test spawns a subprocess
 * or writes a file — except AC21, which round-trips a baseline through a temp
 * feature dir to prove the persisted `packageDirs` is what the gate reads.
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { join } from "node:path";
import type { QualityCommandSpec } from "@nathapp/nax-agent/internal";
import {
  cleanupTempDir,
  type LogCall,
  makeLogger,
  makeMockRuntime,
  makeNaxConfig,
  makePluginRegistry,
  makePRD,
  makeStatusWriter,
  makeStory,
  makeTempDir,
} from "@test/helpers";
import { createConfigLoader, type NaxConfig } from "@/config";
import {
  _captureDeps,
  type CaptureParsedSummary,
  type CaptureRunBaselineOptions,
  type CaptureRunnerResult,
  captureRunBaseline,
} from "@/execution/lifecycle/test-baseline-capture";
import type { CaptureUnit } from "@/execution/lifecycle/test-baseline-units";
import type { RunnerExecutionOptions } from "@/execution/runner-execution";
import { runExecutionPhase } from "@/execution/runner-execution";
import { _unifiedExecutorDeps } from "@/execution/unified-executor";
import type { Finding } from "@/findings";
import * as loggerModule from "@/logger";
import type { SuiteTestCommand } from "@/operations/suite-test-command";
import type { PRD } from "@/prd";
import { createPackageRegistry, type PackageRegistry, type PackageView } from "@/runtime";
import {
  applyBaselineDispositions,
  baselineForPackage,
  readRunBaseline,
  type TestBaseline,
  writeRunBaseline,
} from "@/verification";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** The root every AC names. Nothing touches the disk here — the deps are stubbed. */
const ROOT = "/repo";

const originalDeps = { ..._captureDeps };

/**
 * The registry is opaque in every capture-level AC: `_captureDeps.resolveUnit`
 * is stubbed, so nothing ever calls `resolve`. Throwing keeps the type honest
 * without a cast — a stub that answered would hide a wiring mistake.
 */
const UNUSED_REGISTRY: Pick<PackageRegistry, "resolve"> = {
  resolve: (): PackageView => {
    throw new Error("the package registry is not consulted when resolveUnit is stubbed");
  },
};

let writes: TestBaseline[];
let logCalls: LogCall[];

beforeEach(() => {
  writes = [];
  const logger = makeLogger();
  spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger);
  logCalls = logger.calls;

  _captureDeps.clearStoryBaselines = async () => undefined;
  _captureDeps.resolveTestCommands = async () => undefined;
  _captureDeps.runCommand = async () => ({ success: true, output: "", timedOut: false });
  _captureDeps.parseTestOutput = () => ({ passed: 1, failed: 0, failures: [] });
  _captureDeps.captureGitRef = async () => "base-ref";
  _captureDeps.now = () => "2026-11-16T09:00:00.000Z";
  _captureDeps.regressionGateEnabled = () => true;
  _captureDeps.resolveGateTimeoutSeconds = () => 60;
  _captureDeps.writeRunBaseline = async (_root, _featureId, baseline) => {
    writes.push(baseline);
  };
  _captureDeps.writeStoryBaseline = async () => undefined;
  _captureDeps.resolveUnit = originalDeps.resolveUnit;
});

afterEach(() => {
  Object.assign(_captureDeps, originalDeps);
  mock.restore();
});

function makeOptions(overrides: Partial<CaptureRunBaselineOptions> = {}): CaptureRunBaselineOptions {
  return {
    root: ROOT,
    featureId: "feat-x",
    config: makeNaxConfig({
      execution: { regressionGate: { enabled: true, timeoutSeconds: 60 } },
      quality: { commands: { test: "bun run test" } },
    }),
    workdir: ROOT,
    packageDirs: ["packages/a", "packages/b"],
    packages: UNUSED_REGISTRY,
    ...overrides,
  };
}

function suiteCommand(
  testCmd: QualityCommandSpec,
  cmdWorkdir: string,
  provenance: SuiteTestCommand["provenance"] = "overlay",
): SuiteTestCommand {
  return { testCmd, cmdWorkdir, provenance };
}

/** An enabled unit whose command was resolved from the package overlay. */
function unit(packageDir: string, testCmd: QualityCommandSpec, timeoutSeconds = 60): CaptureUnit {
  return {
    packageDir,
    gateEnabled: true,
    timeoutSeconds,
    command: suiteCommand(testCmd, packageDir === "." ? ROOT : join(ROOT, packageDir)),
  };
}

function gateDisabled(packageDir: string): CaptureUnit {
  return { packageDir, gateEnabled: false, timeoutSeconds: 60 };
}

function noCommand(packageDir: string): CaptureUnit {
  return { packageDir, gateEnabled: true, timeoutSeconds: 60 };
}

/** Stub `resolveUnit` with one answer per package dir; returns the dirs it was asked for. */
function stubUnits(resolve: (packageDir: string) => CaptureUnit): string[] {
  const asked: string[] = [];
  _captureDeps.resolveUnit = async (input) => {
    asked.push(input.packageDir);
    return resolve(input.packageDir);
  };
  return asked;
}

interface RunRecord {
  readonly command: string;
  readonly timeoutSeconds: number;
  readonly workdir: string;
}

/** Record every command run; `respond` decides each one's result. */
function recordRuns(
  respond: (command: string) => CaptureRunnerResult = () => ({ success: true, output: "", timedOut: false }),
): RunRecord[] {
  const runs: RunRecord[] = [];
  _captureDeps.runCommand = async (command, timeoutSeconds, workdir) => {
    runs.push({ command, timeoutSeconds, workdir });
    return respond(command);
  };
  return runs;
}

function onlyCaptured(): Extract<TestBaseline, { kind: "captured" }> {
  expect(writes).toHaveLength(1);
  const baseline = writes[0];
  if (baseline?.kind !== "captured") throw new Error("expected a captured baseline");
  return baseline;
}

function onlyMarker(): Extract<TestBaseline, { kind: "no-baseline" }> {
  expect(writes).toHaveLength(1);
  const marker = writes[0];
  if (marker?.kind !== "no-baseline") throw new Error("expected a no-baseline marker");
  return marker;
}

const FAILING_A: CaptureParsedSummary = {
  passed: 0,
  failed: 1,
  failures: [{ file: "a.test.ts", testName: "fails" }],
};
const GREEN: CaptureParsedSummary = { passed: 1, failed: 0, failures: [] };

// ─────────────────────────────────────────────────────────────────────────────
// AC1 — each unit's command runs in its own cmdWorkdir
// ─────────────────────────────────────────────────────────────────────────────

describe("captureRunBaseline per package — AC1 (command and cwd per unit)", () => {
  test("AC1: runs each unit's command in its cmdWorkdir, one entry at a time", async () => {
    stubUnits((dir) => (dir === "packages/a" ? unit(dir, ["a-one", "a-two"]) : unit(dir, "b-one")));
    const runs = recordRuns();

    await captureRunBaseline(makeOptions());

    expect(runs).toEqual([
      { command: "a-one", timeoutSeconds: 60, workdir: join(ROOT, "packages/a") },
      { command: "a-two", timeoutSeconds: 60, workdir: join(ROOT, "packages/a") },
      { command: "b-one", timeoutSeconds: 60, workdir: join(ROOT, "packages/b") },
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC2 — equivalent commands run once
// ─────────────────────────────────────────────────────────────────────────────

describe("captureRunBaseline per package — AC2 (dedup)", () => {
  test("AC2: two units resolving equal-valued but distinct command arrays share one run", async () => {
    const sharedWorkdir = join(ROOT, "packages/shared");
    stubUnits((dir) => ({
      packageDir: dir,
      gateEnabled: true,
      timeoutSeconds: 60,
      command: suiteCommand(["x", "y"], sharedWorkdir),
    }));
    const runs = recordRuns();

    await captureRunBaseline(makeOptions());

    expect(runs.map((run) => run.command)).toEqual(["x", "y"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3 — package-tagged entries and recorded coverage
// ─────────────────────────────────────────────────────────────────────────────

describe("captureRunBaseline per package — AC3 (package-tagged entries)", () => {
  test("AC3: a failure in packages/a is tagged and both captured packages are recorded", async () => {
    stubUnits((dir) => unit(dir, `run ${dir}`));
    recordRuns((command) =>
      command === "run packages/a"
        ? { success: false, output: "A-FAIL", timedOut: false, exitCode: 1 }
        : { success: true, output: "GREEN", timedOut: false },
    );
    _captureDeps.parseTestOutput = (output) => (output === "A-FAIL" ? FAILING_A : GREEN);

    await captureRunBaseline(makeOptions());

    const baseline = onlyCaptured();
    expect(baseline.packageDirs).toEqual(["packages/a", "packages/b"]);
    expect(baseline.entries).toEqual([{ file: "a.test.ts", testName: "fails", packageDir: "packages/a" }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC4 — a shared command's failures belong to every package in the group
// ─────────────────────────────────────────────────────────────────────────────

describe("captureRunBaseline per package — AC4 (shared command, per-package entries)", () => {
  test("AC4: one shared command naming one failure records it for both packages", async () => {
    const sharedWorkdir = join(ROOT, "packages/shared");
    stubUnits((dir) => ({
      packageDir: dir,
      gateEnabled: true,
      timeoutSeconds: 60,
      command: suiteCommand("shared-test", sharedWorkdir),
    }));
    recordRuns(() => ({ success: false, output: "A-FAIL", timedOut: false, exitCode: 1 }));
    _captureDeps.parseTestOutput = () => FAILING_A;

    await captureRunBaseline(makeOptions());

    expect(onlyCaptured().entries).toEqual([
      { file: "a.test.ts", testName: "fails", packageDir: "packages/a" },
      { file: "a.test.ts", testName: "fails", packageDir: "packages/b" },
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC5 — the root unit's entry carries no packageDir key
// ─────────────────────────────────────────────────────────────────────────────

describe("captureRunBaseline per package — AC5 (root unit)", () => {
  test("AC5: the '.' unit's entry has no packageDir key, the package's does", async () => {
    stubUnits((dir) => unit(dir, `run ${dir}`));
    recordRuns((command) => ({ success: false, output: command, timedOut: false, exitCode: 1 }));
    _captureDeps.parseTestOutput = (output) =>
      output === "run ."
        ? { passed: 0, failed: 1, failures: [{ file: "root.test.ts", testName: "fails" }] }
        : FAILING_A;

    await captureRunBaseline(makeOptions({ packageDirs: [".", "packages/a"] }));

    const entries = onlyCaptured().entries;
    expect(entries[0]).toEqual({ file: "root.test.ts", testName: "fails" });
    expect(entries[0]).not.toHaveProperty("packageDir");
    expect(entries[1]).toEqual({ file: "a.test.ts", testName: "fails", packageDir: "packages/a" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC6 + AC7 — skipped units are logged and absent from the coverage
// ─────────────────────────────────────────────────────────────────────────────

describe("captureRunBaseline per package — AC6 (no test command)", () => {
  test("AC6: packages/b with no command is skipped, logged, and absent from packageDirs", async () => {
    stubUnits((dir) => (dir === "packages/a" ? unit(dir, "run-a") : noCommand(dir)));
    const runs = recordRuns();

    await captureRunBaseline(makeOptions());

    const baseline = onlyCaptured();
    expect(baseline.packageDirs).toEqual(["packages/a"]);
    expect(runs.map((run) => run.command)).toEqual(["run-a"]);
    const skips = logCalls.filter(
      (call) => call.message === "Run-start test baseline skips a package with no test command",
    );
    expect(skips).toHaveLength(1);
    expect(skips[0]).toMatchObject({ level: "info", stage: "execution", data: { packageDir: "packages/b" } });
  });
});

describe("captureRunBaseline per package — AC7 (regression gate disabled)", () => {
  test("AC7: packages/b with the gate off never runs a command and is logged", async () => {
    stubUnits((dir) => (dir === "packages/a" ? unit(dir, "run-a") : gateDisabled(dir)));
    const runs = recordRuns();

    await captureRunBaseline(makeOptions());

    expect(onlyCaptured().packageDirs).toEqual(["packages/a"]);
    expect(runs.map((run) => run.command)).toEqual(["run-a"]);
    const skips = logCalls.filter(
      (call) => call.message === "Run-start test baseline skips a package with the regression gate disabled",
    );
    expect(skips).toHaveLength(1);
    expect(skips[0]).toMatchObject({ level: "info", stage: "execution", data: { packageDir: "packages/b" } });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC8 + AC9 — reasons when no unit is left to run
// ─────────────────────────────────────────────────────────────────────────────

describe("captureRunBaseline per package — AC8 (every unit disabled)", () => {
  test("AC8: two gate-disabled units write gate-disabled", async () => {
    const asked = stubUnits((dir) => gateDisabled(dir));

    await captureRunBaseline(makeOptions());

    expect(asked).toEqual(["packages/a", "packages/b"]);
    expect(onlyMarker()).toMatchObject({ kind: "no-baseline", reason: "gate-disabled" });
  });
});

describe("captureRunBaseline per package — AC9 (one disabled, one commandless)", () => {
  test("AC9: a disabled unit plus a commandless unit write no-test-command", async () => {
    const asked = stubUnits((dir) => (dir === "packages/a" ? gateDisabled(dir) : noCommand(dir)));

    await captureRunBaseline(makeOptions());

    expect(asked).toEqual(["packages/a", "packages/b"]);
    expect(onlyMarker()).toMatchObject({ kind: "no-baseline", reason: "no-test-command" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC10 — a timeout stops the loop with the package's own evidence
// ─────────────────────────────────────────────────────────────────────────────

describe("captureRunBaseline per package — AC10 (timeout)", () => {
  test("AC10: a timed-out package writes timeout with its cwd and stops later groups", async () => {
    stubUnits((dir) => unit(dir, `run ${dir}`));
    const runs = recordRuns((command) =>
      command === "run packages/a"
        ? { success: false, output: "", timedOut: true, exitCode: 124 }
        : { success: true, output: "", timedOut: false },
    );

    await captureRunBaseline(makeOptions());

    const marker = onlyMarker();
    expect(marker.reason).toBe("timeout");
    expect(marker.evidence?.cwd).toBe("packages/a");
    expect(marker.evidence?.command).toBe("run packages/a");
    expect(runs.map((run) => run.command)).toEqual(["run packages/a"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC11 + AC12 + AC13 — grouping, timeouts and command-spec normalisation
// ─────────────────────────────────────────────────────────────────────────────

describe("captureRunBaseline per package — AC11 (distinct commands keep their timeouts)", () => {
  test("AC11: packages/a runs with 60 and packages/b with 90", async () => {
    stubUnits((dir) => unit(dir, `run ${dir}`, dir === "packages/a" ? 60 : 90));
    const runs = recordRuns();

    await captureRunBaseline(makeOptions());

    expect(runs).toEqual([
      { command: "run packages/a", timeoutSeconds: 60, workdir: join(ROOT, "packages/a") },
      { command: "run packages/b", timeoutSeconds: 90, workdir: join(ROOT, "packages/b") },
    ]);
  });
});

describe("captureRunBaseline per package — AC12 (a shared command takes the largest timeout)", () => {
  test("AC12: two units sharing a command run it once with 90", async () => {
    const sharedWorkdir = join(ROOT, "packages/shared");
    stubUnits((dir) => ({
      packageDir: dir,
      gateEnabled: true,
      timeoutSeconds: dir === "packages/a" ? 60 : 90,
      command: suiteCommand("shared-test", sharedWorkdir),
    }));
    const runs = recordRuns();

    await captureRunBaseline(makeOptions());

    expect(runs).toEqual([{ command: "shared-test", timeoutSeconds: 90, workdir: sharedWorkdir }]);
  });
});

describe("captureRunBaseline per package — AC13 (string and list forms are one command)", () => {
  test('AC13: testCmd "x" and ["x"] in the same cmdWorkdir run once', async () => {
    const sharedWorkdir = join(ROOT, "packages/shared");
    stubUnits((dir) => ({
      packageDir: dir,
      gateEnabled: true,
      timeoutSeconds: 60,
      command: suiteCommand(dir === "packages/a" ? "x" : ["x"], sharedWorkdir),
    }));
    const runs = recordRuns();

    await captureRunBaseline(makeOptions());

    expect(runs.map((run) => run.command)).toEqual(["x"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC14 — an unparseable group degrades the whole baseline
// ─────────────────────────────────────────────────────────────────────────────

describe("captureRunBaseline per package — AC14 (unparseable)", () => {
  test("AC14: a failing package naming no failure degrades the baseline with its own cwd", async () => {
    stubUnits((dir) => unit(dir, `run ${dir}`));
    recordRuns((command) => ({ success: false, output: command, timedOut: false, exitCode: 1 }));
    _captureDeps.parseTestOutput = (output) =>
      output === "run packages/b" ? { passed: 9, failed: 9, failures: [] } : FAILING_A;

    await captureRunBaseline(makeOptions());

    const marker = onlyMarker();
    expect(marker.reason).toBe("unparseable");
    expect(marker.evidence?.cwd).toBe("packages/b");
    expect(marker.evidence?.command).toBe("run packages/b");
  });

  // One command naming its failure must not mask another command in the same
  // group that names none: the second's evidence would be discarded and its
  // pre-existing failures would later be labelled as introduced.
  test("AC14: a named failure in one command does not mask a sibling command that names none", async () => {
    stubUnits((dir) => unit(dir, ["suite-a", "suite-b"]));
    recordRuns((command) => ({ success: false, output: command, timedOut: false, exitCode: 1 }));
    _captureDeps.parseTestOutput = (output) =>
      output === "suite-a" ? FAILING_A : { passed: 0, failed: 3, failures: [] };

    await captureRunBaseline(makeOptions({ packageDirs: ["packages/a"] }));

    const marker = onlyMarker();
    expect(marker.reason).toBe("unparseable");
    expect(marker.evidence?.command).toBe("suite-b");
    expect(marker.evidence?.cwd).toBe("packages/a");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC15 + AC16 — the single-package path is unchanged
// ─────────────────────────────────────────────────────────────────────────────

describe("captureRunBaseline — AC15 (packageDirs ['.'] keeps the root path)", () => {
  test("AC15: the root capture resolves the root command and never asks for a unit", async () => {
    const resolved: Array<{ config: unknown; workdir: string }> = [];
    _captureDeps.resolveTestCommands = async (config, workdir) => {
      resolved.push({ config, workdir });
      return "bun run test";
    };
    const asked = stubUnits((dir) => unit(dir, "never"));

    const options = makeOptions({ packageDirs: ["."] });
    await captureRunBaseline(options);

    expect(asked).toEqual([]);
    expect(resolved).toEqual([{ config: options.config, workdir: options.workdir }]);
    expect(onlyCaptured()).not.toHaveProperty("packageDirs");
  });
});

describe("captureRunBaseline — AC16 (no registry keeps the root path)", () => {
  test("AC16: package dirs without a registry resolve the root command", async () => {
    const resolved: Array<{ config: unknown; workdir: string }> = [];
    _captureDeps.resolveTestCommands = async (config, workdir) => {
      resolved.push({ config, workdir });
      return "bun run test";
    };
    const asked = stubUnits((dir) => unit(dir, "never"));

    const options = makeOptions({ packages: undefined });
    await captureRunBaseline(options);

    expect(asked).toEqual([]);
    expect(resolved).toEqual([{ config: options.config, workdir: options.workdir }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC17 + AC18 — the production unit resolver
// ─────────────────────────────────────────────────────────────────────────────

describe("_captureDeps.resolveUnit — AC17 (gate switch from the package config)", () => {
  test("AC17: a package whose merged config disables the gate yields no command", async () => {
    // The SHIPPED gate predicate — this AC is about reading it from the
    // package's config, so the per-test `() => true` stub must not stand in.
    _captureDeps.regressionGateEnabled = originalDeps.regressionGateEnabled;
    _captureDeps.resolveGateTimeoutSeconds = originalDeps.resolveGateTimeoutSeconds;
    const registry = createPackageRegistry(
      createConfigLoader(makeNaxConfig({ execution: { regressionGate: { enabled: false } } })),
      ROOT,
    );
    await registry.hydrate(["packages/a"], async () => null);

    const resolved = await callProductionResolveUnit(registry, "packages/a");

    expect(resolved.packageDir).toBe("packages/a");
    expect(resolved.gateEnabled).toBe(false);
    expect(resolved).not.toHaveProperty("command");
  });
});

describe("_captureDeps.resolveUnit — AC18 (the package's resolved suite command)", () => {
  test("AC18: an overlay test command resolves with its own package cwd and provenance", async () => {
    const config = makeNaxConfig();
    // A complete overlay: only `quality.commands.test` differs from the root.
    const overlay: Partial<NaxConfig> = {
      quality: { ...config.quality, commands: { ...config.quality.commands, test: "bun run test" } },
    };
    const registry = createPackageRegistry(createConfigLoader(config), ROOT);
    await registry.hydrate(["packages/a"], async () => overlay);

    const resolved = await callProductionResolveUnit(registry, "packages/a");

    expect(resolved.gateEnabled).toBe(true);
    expect(resolved.command).toEqual({
      testCmd: "bun run test",
      cmdWorkdir: join(ROOT, "packages/a"),
      provenance: "overlay",
    });
  });
});

/** Call the SHIPPED resolver — never the per-test overrides. */
function callProductionResolveUnit(registry: PackageRegistry, packageDir: string): Promise<CaptureUnit> {
  const shipped = originalDeps.resolveUnit;
  if (shipped === undefined) throw new Error("production resolveUnit is not wired into _captureDeps");
  return shipped({ packages: registry, root: ROOT, packageDir });
}

// ─────────────────────────────────────────────────────────────────────────────
// AC19 — the call site passes the pending stories' packages
// ─────────────────────────────────────────────────────────────────────────────

describe("runExecutionPhase — AC19 (pending story packages resolved in order)", () => {
  const origRunIteration = _unifiedExecutorDeps.runIteration;
  const origRunWorkflowPreflight = _unifiedExecutorDeps.runWorkflowPreflight;

  beforeEach(() => {
    _unifiedExecutorDeps.runIteration = async () => ({
      prd: makePRD({ userStories: [makeStory({ id: "US-001", status: "passed", passes: true })] }),
      storiesCompletedDelta: 0,
      costDelta: 0,
      prdDirty: false,
      finalAction: "continue",
    });
    _unifiedExecutorDeps.runWorkflowPreflight = async () => {};
  });

  afterEach(() => {
    _unifiedExecutorDeps.runIteration = origRunIteration;
    _unifiedExecutorDeps.runWorkflowPreflight = origRunWorkflowPreflight;
  });

  function makeRunOptions(): RunnerExecutionOptions {
    const runtime = makeMockRuntime();
    return {
      prdPath: "/tmp/nax-runner-exec-units/prd.json",
      workdir: "/tmp/nax-runner-exec-units",
      config: makeNaxConfig(),
      hooks: { hooks: {}, _skipGlobal: false },
      feature: "feat-units",
      featureDir: undefined,
      dryRun: false,
      useBatch: false,
      statusWriter: makeStatusWriter(),
      statusFile: "/tmp/nax-runner-exec-units/status.json",
      logFilePath: undefined,
      runId: "run-units",
      startedAt: new Date().toISOString(),
      startTime: Date.now(),
      formatterMode: "quiet",
      headless: false,
      parallel: undefined,
      abortSignal: new AbortController().signal,
      sessionManager: runtime.sessionManager,
      runtime,
      agentManager: runtime.agentManager,
      pluginProviderCache: undefined,
      providerWeightsCache: undefined,
    };
  }

  const mixedPRD = (): PRD =>
    makePRD({
      userStories: [
        makeStory({ id: "US-001", status: "pending", passes: false, workdir: "packages/b" }),
        makeStory({ id: "US-002", status: "pending", passes: false, workdir: "packages/a" }),
        makeStory({ id: "US-003", status: "passed", passes: true, workdir: "packages/c" }),
        makeStory({ id: "US-004", status: "blocked", passes: false, workdir: "packages/d" }),
        makeStory({ id: "US-005", status: "pending", passes: false }),
      ],
    });

  test("AC19: resolves '.', 'packages/a' and 'packages/b' in that order with the run registry", async () => {
    const calls: Array<{ packageDir: string; packages: unknown }> = [];
    _captureDeps.resolveUnit = async (input) => {
      calls.push({ packageDir: input.packageDir, packages: input.packages });
      return { packageDir: input.packageDir, gateEnabled: false, timeoutSeconds: 60 };
    };
    _captureDeps.writeRunBaseline = async (_root, _featureId, baseline) => {
      writes.push(baseline);
    };
    const options = makeRunOptions();

    await runExecutionPhase(options, mixedPRD(), makePluginRegistry());

    expect(calls.map((call) => call.packageDir)).toEqual([".", "packages/a", "packages/b"]);
    expect(calls.every((call) => call.packages === options.runtime.packages)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC20 — a runner throw stops the loop and names its command
// ─────────────────────────────────────────────────────────────────────────────

describe("captureRunBaseline per package — AC20 (runner throw)", () => {
  test("AC20: a throwing group writes the error marker and runs no later group", async () => {
    stubUnits((dir) => unit(dir, `run ${dir}`));
    const runs = recordRuns((command) => {
      if (command === "run packages/a") throw new Error("spawn failed");
      return { success: true, output: "", timedOut: false };
    });

    await captureRunBaseline(makeOptions());

    const marker = onlyMarker();
    expect(marker.reason).toBe("error");
    expect(marker.evidence?.command).toBe("run packages/a");
    expect(marker.evidence?.error).toBe("spawn failed");
    expect(runs.map((run) => run.command)).toEqual(["run packages/a"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC21 — a package skipped for no command is unattributed at the gate
// ─────────────────────────────────────────────────────────────────────────────

describe("captureRunBaseline per package — AC21 (skipped package is unattributed)", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) cleanupTempDir(dir);
    tempDirs.length = 0;
  });

  test("AC21: a package absent from packageDirs has no baseline, so its findings are unattributed", async () => {
    const root = makeTempDir("nax-baseline-units-");
    tempDirs.push(root);
    // The baseline must reach the disk: the gate reads the persisted artifact.
    // The production writer is imported directly rather than taken from the
    // module-load `_captureDeps` snapshot, which another file in the same
    // process may already have replaced (test files share one process).
    _captureDeps.writeRunBaseline = writeRunBaseline;
    stubUnits((dir) => (dir === "packages/a" ? unit(dir, "run-a") : noCommand(dir)));
    recordRuns();

    await captureRunBaseline(makeOptions({ root }));

    const persisted = await readRunBaseline(root, "feat-x");
    expect(persisted?.kind).toBe("captured");
    if (persisted?.kind !== "captured") throw new Error("expected a captured baseline");
    expect(persisted.packageDirs).toEqual(["packages/a"]);

    // What `labelFindingsWithBaseline` does with that artifact for packages/b.
    const finding: Finding = {
      source: "test-runner",
      severity: "error",
      category: "test",
      file: "b.test.ts",
      message: "b.test.ts > t failed",
    };
    const labelled = applyBaselineDispositions(
      [finding],
      baselineForPackage(persisted, "packages/b"),
      baselineForPackage(persisted, "packages/b"),
    );

    expect(labelled.map((f) => f.baselineDisposition)).toEqual(["unattributed"]);
  });
});
