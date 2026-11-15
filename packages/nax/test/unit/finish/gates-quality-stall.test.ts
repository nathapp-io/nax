/**
 * The resolved stall policy on gate descriptions, and the evidence a detector
 * stop leaves on a gate record (review-and-gate-guards US-007).
 *
 * `GateCommand` is the policy carrier: `resolveGateCommands` resolves the
 * configured policy once, onto every gate it produces, and `runQualityGates`
 * completes whatever a hand-built gate does not carry from the leaf default.
 * Split from `gates-quality.test.ts` by concern — the root/overlay gate rules
 * stay there, the policy carrier lives here.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { NaxConfig } from "@/config";
import { DEFAULT_CONFIG, PROJECT_NAX_DIR } from "@/config";
import { NaxError } from "@/errors";
import type { GateRunRecord } from "@/finish";
import { _qualityGateDeps, classifyGateExit, resolveGateCommands, runQualityGates } from "@/finish";
import type { QualityCommandResult } from "@/quality";
import { DEFAULT_GATE_STALL_POLICY, type GateStopReason } from "@/utils/gate-stall";

const original = { ..._qualityGateDeps };
afterEach(() => Object.assign(_qualityGateDeps, original));

/** A policy that is neither the default nor zero on either detector. */
const ROOT_POLICY = { repeatedLineThreshold: 10, silenceTimeoutSeconds: 5 };

/** The structured evidence a detector stop leaves on a result and a record. */
const REPEATED_OUTPUT: GateStopReason = {
  kind: "repeated-output",
  stream: "stdout",
  count: 100,
  threshold: 100,
};

/** A full NaxConfig carrying both inputs this story reads: commands and a policy. */
function configWithStall(
  commands: NaxConfig["quality"]["commands"],
  stallDetection: NaxConfig["quality"]["stallDetection"],
): NaxConfig {
  return {
    ...DEFAULT_CONFIG,
    quality: { ...DEFAULT_CONFIG.quality, commands, stallDetection },
  };
}

/** A config with `<key>` configured and no stall policy block at all. */
function configWithoutStallPolicy(commands: NaxConfig["quality"]["commands"]): NaxConfig {
  const config = { ...DEFAULT_CONFIG, quality: { ...DEFAULT_CONFIG.quality, commands } };
  Reflect.deleteProperty(config.quality, "stallDetection");
  return config;
}

/** A `_qualityGateDeps.run` result for `commandName`. */
function gateResult(commandName: string, overrides: Partial<QualityCommandResult> = {}): QualityCommandResult {
  return {
    commandName,
    command: "cmd",
    success: true,
    exitCode: 0,
    output: "ok",
    durationMs: 1,
    timedOut: false,
    ...overrides,
  };
}

/** A raw package overlay that names one detector and leaves the other absent. */
function overlayNaming(
  commands: NaxConfig["quality"]["commands"],
  overrides: { repeatedLineThreshold?: number; silenceTimeoutSeconds?: number },
): Partial<NaxConfig> {
  const quality = {
    ...DEFAULT_CONFIG.quality,
    commands,
    stallDetection: {
      repeatedLineThreshold: overrides.repeatedLineThreshold ?? 0,
      silenceTimeoutSeconds: overrides.silenceTimeoutSeconds ?? 0,
    },
  };
  // A `.nax/mono/<pkg>/config.json` names only the fields it overrides, so the
  // detector it leaves out is genuinely absent here, not the default.
  for (const key of ["repeatedLineThreshold", "silenceTimeoutSeconds"] as const) {
    if (!(key in overrides)) Reflect.deleteProperty(quality.stallDetection, key);
  }
  return { quality };
}

describe("resolveGateCommands — stall policy", () => {
  test("US-007 AC-1: root gates carry the root's resolved stall policy", async () => {
    _qualityGateDeps.loadConfig = async () => configWithStall({ test: "root test" }, ROOT_POLICY);
    _qualityGateDeps.loadPackageOverride = async () => null;

    expect(await resolveGateCommands("/repo", [])).toEqual([
      { name: "test", command: "root test", cwd: "/repo", stallDetection: ROOT_POLICY },
    ]);
  });

  test("US-007 AC-1: a root config with no stall block gives every root gate the resolved default", async () => {
    _qualityGateDeps.loadConfig = async () => configWithoutStallPolicy({ lint: "biome lint" });
    _qualityGateDeps.loadPackageOverride = async () => null;

    expect(await resolveGateCommands("/repo", [])).toEqual([
      { name: "lint", command: "biome lint", cwd: "/repo", stallDetection: DEFAULT_GATE_STALL_POLICY },
    ]);
  });

  test("US-007 AC-2: an eligible package gate carries the field-wise merged overlay policy", async () => {
    // The overlay names only silence; the repetition threshold comes from the
    // root, and the root gate keeps its own silence value.
    _qualityGateDeps.loadConfig = async () => configWithStall({ lint: "root lint" }, ROOT_POLICY);
    _qualityGateDeps.loadPackageOverride = async () =>
      overlayNaming({ test: "pkg test" }, { silenceTimeoutSeconds: 0 });

    expect(await resolveGateCommands("/repo", ["pkg"])).toEqual([
      { name: "lint", command: "root lint", cwd: "/repo", stallDetection: ROOT_POLICY },
      {
        name: "test@pkg",
        command: "pkg test",
        cwd: "/repo/pkg",
        stallDetection: { repeatedLineThreshold: ROOT_POLICY.repeatedLineThreshold, silenceTimeoutSeconds: 0 },
      },
    ]);
  });

  test("US-007 AC-2: an overlay that names no stall block inherits the whole root policy", async () => {
    _qualityGateDeps.loadConfig = async () => configWithStall({ lint: "root lint" }, ROOT_POLICY);
    _qualityGateDeps.loadPackageOverride = async () => overlayNaming({ test: "pkg test" }, {});

    expect(await resolveGateCommands("/repo", ["pkg"])).toEqual([
      { name: "lint", command: "root lint", cwd: "/repo", stallDetection: ROOT_POLICY },
      { name: "test@pkg", command: "pkg test", cwd: "/repo/pkg", stallDetection: ROOT_POLICY },
    ]);
  });

  test("US-007 AC-3: root-key precedence is unchanged when an overlay names the same gate key", async () => {
    _qualityGateDeps.loadConfig = async () => configWithStall({ test: "root test" }, ROOT_POLICY);
    _qualityGateDeps.loadPackageOverride = async () => ({
      quality: {
        ...DEFAULT_CONFIG.quality,
        commands: { test: "pkg test" },
        stallDetection: { repeatedLineThreshold: 3, silenceTimeoutSeconds: 3 },
      },
    });

    expect(await resolveGateCommands("/repo", ["pkg"])).toEqual([
      { name: "test", command: "root test", cwd: "/repo", stallDetection: ROOT_POLICY },
    ]);
  });

  test("US-007 AC-4: identical command, setup and cwd with different policies stay distinct runs", async () => {
    // "." resolves to the root's own cwd, so the two gates differ only by the
    // policy they run under: the root's `build` under the root policy, and the
    // overlay's `typecheck` under the field-wise merged one. Without the policy
    // in run identity the second was silently dropped as a duplicate run.
    _qualityGateDeps.loadConfig = async () => configWithStall({ build: "tsc --noEmit" }, ROOT_POLICY);
    _qualityGateDeps.loadPackageOverride = async () =>
      overlayNaming({ typecheck: "tsc --noEmit" }, { silenceTimeoutSeconds: 1 });

    expect(await resolveGateCommands("/repo", ["."])).toEqual([
      { name: "build", command: "tsc --noEmit", cwd: "/repo", stallDetection: ROOT_POLICY },
      {
        name: "typecheck@.",
        command: "tsc --noEmit",
        cwd: "/repo",
        stallDetection: { repeatedLineThreshold: ROOT_POLICY.repeatedLineThreshold, silenceTimeoutSeconds: 1 },
      },
    ]);
  });

  test("US-007 AC-5: overlay gates whose resolved policies are identical still dedupe", async () => {
    // The overlay names a stall block explicitly, and it resolves to the root's
    // policy field for field — the same run, so one gate.
    _qualityGateDeps.loadConfig = async () => configWithStall({ build: "tsc --noEmit" }, ROOT_POLICY);
    _qualityGateDeps.loadPackageOverride = async () => ({
      quality: { ...DEFAULT_CONFIG.quality, commands: { typecheck: "tsc --noEmit" }, stallDetection: ROOT_POLICY },
    });

    expect(await resolveGateCommands("/repo", ["."])).toEqual([
      { name: "build", command: "tsc --noEmit", cwd: "/repo", stallDetection: ROOT_POLICY },
    ]);
  });
});

describe("resolveGateCommands — a package's DECLARED policy is validated (B4)", () => {
  /** An overlay whose declared policy block is exactly `raw` plus the named command. */
  function overlayWithPolicy(commands: NaxConfig["quality"]["commands"], raw: unknown): Partial<NaxConfig> {
    const quality = { ...DEFAULT_CONFIG.quality, commands };
    // A `.nax/mono/<pkg>/config.json` is raw JSON: `loadPackageOverride` returns
    // its declared values unparsed, so this is exactly what the gate reads.
    Reflect.set(quality, "stallDetection", raw);
    return { quality };
  }

  test.each([
    ["repeatedLineThreshold: 1", { repeatedLineThreshold: 1 }],
    ["silenceTimeoutSeconds: -7", { silenceTimeoutSeconds: -7 }],
  ])("rejects a schema-invalid %s with a configuration error", async (_label, raw) => {
    _qualityGateDeps.loadConfig = async () => configWithStall({}, ROOT_POLICY);
    _qualityGateDeps.loadPackageOverride = async () => overlayWithPolicy({ test: "pkg test" }, raw);
    const runCalls: string[] = [];
    _qualityGateDeps.run = async (opts) => {
      runCalls.push(opts.commandName);
      return gateResult(opts.commandName);
    };

    let caught: unknown;
    try {
      await resolveGateCommands("/repo", ["pkg"]);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(NaxError);
    expect(caught instanceof NaxError ? caught.code : undefined).toBe("PER_PACKAGE_PROFILE_INVALID");
    // The invalid value never becomes a scheduled gate, so nothing can run it.
    expect(runCalls).toEqual([]);
  });

  test("the rejection names the package and its config file", async () => {
    _qualityGateDeps.loadConfig = async () => configWithStall({}, ROOT_POLICY);
    _qualityGateDeps.loadPackageOverride = async () =>
      overlayWithPolicy({ test: "pkg test" }, { repeatedLineThreshold: 1 });

    const caught = await resolveGateCommands("/repo", ["pkg"]).then(
      () => undefined,
      (err: unknown) => err,
    );

    expect(caught instanceof NaxError ? caught.message : "").toContain('"pkg"');
    expect(caught instanceof NaxError ? caught.message : "").toContain(
      join(PROJECT_NAX_DIR, "mono", "pkg", "config.json"),
    );
  });

  test("a valid sparse overlay keeps sibling inheritance and an explicit zero", async () => {
    _qualityGateDeps.loadConfig = async () => configWithStall({ lint: "root lint" }, ROOT_POLICY);
    _qualityGateDeps.loadPackageOverride = async () =>
      overlayWithPolicy({ test: "pkg test" }, { silenceTimeoutSeconds: 0 });

    expect(await resolveGateCommands("/repo", ["pkg"])).toEqual([
      { name: "lint", command: "root lint", cwd: "/repo", stallDetection: ROOT_POLICY },
      {
        name: "test@pkg",
        command: "pkg test",
        cwd: "/repo/pkg",
        stallDetection: { repeatedLineThreshold: ROOT_POLICY.repeatedLineThreshold, silenceTimeoutSeconds: 0 },
      },
    ]);
  });
});

describe("runQualityGates — stall policy", () => {
  test("US-007 AC-8: a hand-built gate with no policy runs with DEFAULT_GATE_STALL_POLICY", async () => {
    const seen: unknown[] = [];
    _qualityGateDeps.run = async (opts) => {
      seen.push(opts.stallDetection);
      return gateResult(opts.commandName);
    };

    await runQualityGates("/repo", [{ name: "lint", command: "cmd", cwd: "/repo" }]);

    expect(seen).toEqual([DEFAULT_GATE_STALL_POLICY]);
  });

  test("US-007 AC-9: an explicit both-zero policy is honored instead of the default", async () => {
    const disabled = { repeatedLineThreshold: 0, silenceTimeoutSeconds: 0 };
    const seen: unknown[] = [];
    _qualityGateDeps.run = async (opts) => {
      seen.push(opts.stallDetection);
      return gateResult(opts.commandName);
    };

    await runQualityGates("/repo", [{ name: "lint", command: "cmd", cwd: "/repo", stallDetection: disabled }]);

    expect(seen).toEqual([disabled]);
  });

  test("US-007 AC-10: a detector-stopped exit -1 is timed-out, not not-run", async () => {
    _qualityGateDeps.run = async (opts) =>
      gateResult(opts.commandName, {
        success: false,
        exitCode: -1,
        timedOut: true,
        stopReason: REPEATED_OUTPUT,
        output: "stopped early: repeated output",
      });
    const records: GateRunRecord[] = [];

    await runQualityGates("/repo", [{ name: "test", command: "cmd", cwd: "/repo" }], {
      onGate: (record) => records.push(record),
    });

    expect(records[0]?.status).toBe("timed-out");
    // A stop is detector evidence that the run ended early, and it wins over
    // the -1 a killed child reports — which on its own would read as not-run.
    expect(classifyGateExit({ exitCode: -1, timedOut: false, stopReason: REPEATED_OUTPUT })).toBe("timed-out");
  });

  test("US-007 AC-11: the stop reason is copied to the gate record", async () => {
    _qualityGateDeps.run = async (opts) =>
      gateResult(opts.commandName, { success: false, exitCode: -1, timedOut: true, stopReason: REPEATED_OUTPUT });
    const records: GateRunRecord[] = [];

    await runQualityGates("/repo", [{ name: "test", command: "cmd", cwd: "/repo" }], {
      onGate: (record) => records.push(record),
    });

    expect(records[0]?.stopReason).toEqual(REPEATED_OUTPUT);
  });

  test("US-007 AC-12: the gates after a stopped gate still run", async () => {
    const calls: string[] = [];
    _qualityGateDeps.run = async (opts) => {
      calls.push(opts.commandName);
      return opts.commandName === "build"
        ? gateResult(opts.commandName, { success: false, exitCode: -1, timedOut: true, stopReason: REPEATED_OUTPUT })
        : gateResult(opts.commandName);
    };
    const records: GateRunRecord[] = [];

    const result = await runQualityGates(
      "/repo",
      [
        { name: "build", command: "cmd", cwd: "/repo" },
        { name: "lint", command: "cmd", cwd: "/repo" },
      ],
      { onGate: (record) => records.push(record) },
    );

    expect(calls).toEqual(["build", "lint"]);
    expect(records.map((r) => r.status)).toEqual(["timed-out", "passed"]);
    // The stopped gate's evidence is still on its record — continuing never
    // rewrites what already happened.
    expect(records[0]?.stopReason).toEqual(REPEATED_OUTPUT);
    expect(result.failing).toEqual(["build"]);
  });

  test("US-007 AC-13: a record carries stopReason only when a detector stopped the run", async () => {
    _qualityGateDeps.run = async (opts) => {
      if (opts.commandName === "build") return gateResult(opts.commandName);
      if (opts.commandName === "lint") {
        return gateResult(opts.commandName, {
          success: false,
          exitCode: -1,
          timedOut: true,
          stopReason: REPEATED_OUTPUT,
        });
      }
      return gateResult(opts.commandName, { success: false, exitCode: -1, timedOut: true });
    };
    const records: GateRunRecord[] = [];

    await runQualityGates(
      "/repo",
      [
        { name: "build", command: "cmd", cwd: "/repo" },
        { name: "lint", command: "cmd", cwd: "/repo" },
        { name: "test", command: "cmd", cwd: "/repo" },
      ],
      { onGate: (record) => records.push(record) },
    );

    // The stopped gate carries the key; neither an ordinary pass nor a wall
    // timeout carries it at all.
    expect(records.map((r) => Object.hasOwn(r, "stopReason"))).toEqual([false, true, false]);
    expect(records.map((r) => r.status)).toEqual(["passed", "timed-out", "timed-out"]);
  });
});
