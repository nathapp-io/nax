/**
 * The gate stall policy end to end through the real finish helpers
 * (review-and-gate-guards US-007).
 *
 * `resolveGateCommands` resolves the configured policy onto every gate it
 * produces, `runRepoGates` hands those gates to `runQualityGates`, and
 * `runQualityGates` completes whatever a gate does not carry before the
 * quality runner sees it. These tests drive that composition with the real
 * resolver, the real gate runner (`_featureDeps.runQualityGates`) and — for the
 * first one — the real quality runner, so the policy is observed where it is
 * finally used rather than at a stub's own convenience.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cleanupTempDir, makeFeatureContext, makeNaxConfig, makeTempDir } from "@test/helpers";
import type { NaxConfig } from "@/config";
import type { GateRunRecord } from "@/finish";
import { _qualityGateDeps, resolveGateCommands, runQualityGates } from "@/finish";
import type { QualityCommandResult } from "@/quality";
import { _qualityRunnerDeps } from "@/quality/runner";
import type { GateStallPolicy, GateStopReason } from "@/utils/gate-stall";
import { _featureDeps } from "@/workflow/feature-deps";
import { runRepoGates } from "@/workflow/repo-gates";

const originalQuality = { ..._qualityGateDeps };
const originalFinish = { ..._featureDeps };
const originalRunner = { ..._qualityRunnerDeps };

afterEach(() => {
  Object.assign(_qualityGateDeps, originalQuality);
  Object.assign(_featureDeps, originalFinish);
  Object.assign(_qualityRunnerDeps, originalRunner);
});

/** The structured evidence a detector stop leaves on a result and a record. */
const REPEATED_OUTPUT: GateStopReason = {
  kind: "repeated-output",
  stream: "stdout",
  count: 100,
  threshold: 100,
};

/** A config whose root `quality` block is exactly `commands` plus `stallDetection`. */
function configWith(
  commands: NaxConfig["quality"]["commands"],
  stallDetection: NaxConfig["quality"]["stallDetection"],
): NaxConfig {
  return makeNaxConfig({ quality: { commands, stallDetection } });
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

describe("runRepoGates — the policy reaching the quality runner", () => {
  test("US-007 AC-6: the configured gate's resolved policy reaches the real runQualityCommand", async () => {
    const dir = makeTempDir("gate-policy-run");
    const policies: GateStallPolicy[] = [];
    try {
      _qualityGateDeps.loadConfig = async () =>
        configWith({ lint: "echo gate-ok" }, { repeatedLineThreshold: 7, silenceTimeoutSeconds: 3 });
      _qualityGateDeps.loadPackageOverride = async () => null;
      // The observation point is the real runner's monitor factory: the policy
      // it is handed is the policy `runQualityCommand` will enforce.
      _qualityRunnerDeps.createGateStallMonitor = (options) => {
        policies.push(options.policy);
        return { observe: () => {}, end: () => {}, dispose: () => {} };
      };

      const run = await runRepoGates(makeFeatureContext({ projectDir: dir }));

      expect(run.summary).toEqual({ ran: ["lint"], failing: [] });
      expect(run.findings).toEqual([]);
      expect(policies).toEqual([{ repeatedLineThreshold: 7, silenceTimeoutSeconds: 3 }]);
    } finally {
      cleanupTempDir(dir);
    }
  });

  test("US-007 AC-7: the sparse policy resolves through _qualityGateDeps and the completed one reaches the runner", async () => {
    const inputs: unknown[] = [];
    const runCalls: { commandName: string; stallDetection: unknown }[] = [];
    const originalResolve = _qualityGateDeps.resolveStallDetection;
    // Delegating recorder, not a replacement: the completed value is still the
    // leaf's, so the runner's argument is real, and the *call* is what proves
    // the resolution happened at the production entry.
    _qualityGateDeps.resolveStallDetection = (overrides) => {
      inputs.push(overrides);
      return originalResolve(overrides);
    };
    const sparse = configWith({ lint: "root lint" }, { repeatedLineThreshold: 7, silenceTimeoutSeconds: 0 });
    // The config names one detector only; the other is the resolver's to fill.
    const sparsePolicy = sparse.quality.stallDetection;
    if (sparsePolicy === undefined) throw new Error("expected a stall policy block");
    Reflect.deleteProperty(sparsePolicy, "silenceTimeoutSeconds");
    _qualityGateDeps.loadConfig = async () => sparse;
    _qualityGateDeps.loadPackageOverride = async () => null;
    _qualityGateDeps.run = async (opts) => {
      runCalls.push({ commandName: opts.commandName, stallDetection: opts.stallDetection });
      return gateResult(opts.commandName);
    };

    await runRepoGates(makeFeatureContext());

    // Once from resolveGateCommands for the root policy, with the sparse input
    // the config actually carries…
    expect(inputs[0]).toEqual({ repeatedLineThreshold: 7 });
    // …and once from runQualityGates for the gate it schedules.
    expect(inputs[1]).toEqual({ repeatedLineThreshold: 7, silenceTimeoutSeconds: 0 });
    expect(runCalls).toEqual([
      { commandName: "lint", stallDetection: { repeatedLineThreshold: 7, silenceTimeoutSeconds: 0 } },
    ]);
  });
});

describe("runQualityGates — the e2e gate's policy on its setup", () => {
  const E2E_POLICY = { repeatedLineThreshold: 50, silenceTimeoutSeconds: 2 };

  /** Stub the config loaders for a root config carrying `e2e` + `e2eSetup`. */
  function stubE2eConfig(policy: GateStallPolicy): void {
    _qualityGateDeps.loadConfig = async () =>
      configWith({ e2e: "bunx playwright test", e2eSetup: "docker compose up -d" }, policy);
    _qualityGateDeps.loadPackageOverride = async () => null;
  }

  test("US-007 AC-14: the e2e gate's policy is passed to its setup command", async () => {
    stubE2eConfig(E2E_POLICY);
    const calls: { commandName: string; stallDetection: unknown }[] = [];
    _qualityGateDeps.run = async (opts) => {
      calls.push({ commandName: opts.commandName, stallDetection: opts.stallDetection });
      return gateResult(opts.commandName);
    };

    const gates = await resolveGateCommands("/repo", []);
    await runQualityGates("/repo", gates);

    expect(calls).toEqual([
      { commandName: "e2e:setup", stallDetection: E2E_POLICY },
      { commandName: "e2e", stallDetection: E2E_POLICY },
    ]);
  });

  test("US-007 AC-15 + AC-16: a stopped setup gives that gate's timed-out setup record and the journey never starts", async () => {
    stubE2eConfig(E2E_POLICY);
    const calls: string[] = [];
    _qualityGateDeps.run = async (opts) => {
      calls.push(opts.commandName);
      return opts.commandName === "e2e:setup"
        ? gateResult(opts.commandName, {
            success: false,
            exitCode: -1,
            timedOut: true,
            stopReason: REPEATED_OUTPUT,
            output: "stopped early: repeated output",
            durationMs: 21,
          })
        : gateResult(opts.commandName);
    };
    const records: GateRunRecord[] = [];

    const gates = await resolveGateCommands("/repo", []);
    const result = await runQualityGates("/repo", gates, { onGate: (record) => records.push(record) });

    expect(calls).toEqual(["e2e:setup"]);
    expect(records).toEqual([
      {
        name: "e2e",
        cwd: "/repo",
        status: "timed-out",
        exitCode: -1,
        durationMs: 21,
        failedPhase: "setup",
        stopReason: REPEATED_OUTPUT,
        output: "stopped early: repeated output",
      },
    ]);
    expect(result.failing).toEqual(["e2e"]);
    expect(result.passed).toBe(false);
  });
});
