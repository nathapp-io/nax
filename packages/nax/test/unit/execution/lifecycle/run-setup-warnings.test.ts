/**
 * Unit tests for src/execution/lifecycle/run-setup-warnings.ts — US-003
 * "Warn when gated or escalate stages cannot offer Bash".
 *
 * Two halves:
 *  - `warnInertBashStages` itself (AC10–AC13): one warning per inert stage, the
 *    data shape, the fix-naming message, and silence when nothing is inert.
 *  - the wiring into the real `setupRun` (AC14–AC15): the warning is emitted at
 *    run start, driven under `withWarnSpy` so the assertion is against the real
 *    logger rather than a stub passed in by the test.
 *
 * Split from run-setup.test.ts, which is at 772 lines and would pass the
 * 800-line test limit with these cases added.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupTempDir,
  type DeepPartial,
  makeLogger,
  makeMockRuntime,
  makeNaxConfig,
  makePRD,
  makeTempDir,
  withDepsRestore,
  withWarnSpy,
} from "@test/helpers";
import type { z } from "zod";
import type { NaxConfig } from "@/config";
import { PermissionsBlockSchema } from "@/config/schemas-execution";
import { _runSetupDeps, type RunSetupOptions, setupRun } from "@/execution/lifecycle/run-setup";
import { warnInertBashStages } from "@/execution/lifecycle/run-setup-warnings";
import type { NaxRuntime } from "@/runtime";

// ─────────────────────────────────────────────────────────────────────────────
// warnInertBashStages — the pure warning emitter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The `permissions` block as a CALLER writes it: `PermissionsBlockSchema` is
 * the SSOT that declares `allow` / `deny` / `ask` (and validates them at load),
 * so the AC-literal `allow` key is checked against the schema's own input type
 * and then parsed by it — no widening, no cast.
 *
 * KNOWN SOURCE GAP the tests must not paper over: `ExecutionConfig`
 * (`src/config/runtime-types.ts:144-152`) still declares only the legacy
 * `allowedTools` field, so the public `NaxConfig` type cannot express the
 * documented `permissions.<stage>.allow` configuration. That is why the parsed
 * block is handed to `makeNaxConfig` as a value rather than written inline as a
 * literal — the only construction a typed caller has. Widening
 * `ExecutionConfig` with the three rule lists is the real fix; nothing here
 * asserts the narrow type.
 */
type PermissionsBlockInput = z.input<typeof PermissionsBlockSchema>;

function configWithPermissions(
  execution: DeepPartial<NaxConfig["execution"]>,
  permissions: PermissionsBlockInput,
): NaxConfig {
  return makeNaxConfig({
    execution: { ...execution, permissions: PermissionsBlockSchema.parse(permissions) },
  });
}

/** Escalate, with a single Bash(...) rule on `run`. */
function escalateWithRunGranted(): NaxConfig {
  return configWithPermissions({ bashApproval: "escalate" }, { run: { allow: ["Bash(ls *)"] } });
}

/** A Bash(...) rule on every stage that declares the tool. */
function configWithEveryStageGranted(bashApproval: "gated" | "escalate"): NaxConfig {
  return configWithPermissions(
    { bashApproval },
    {
      run: { allow: ["Bash(ls *)"] },
      review: { allow: ["Bash(git status*)"] },
      rectification: { allow: ["Bash(bun test*)"] },
      acceptance: { allow: ["Bash(bun run*)"] },
    },
  );
}

const INERT_STAGES = ["acceptance", "rectification", "review"] as const;

describe("warnInertBashStages — US-003 AC10: one warning per inert stage", () => {
  test("AC10: warns exactly three times, stage permissions, for review/rectification/acceptance", () => {
    const logger = makeLogger();

    warnInertBashStages(escalateWithRunGranted(), logger);

    const warns = logger.calls.filter((call) => call.level === "warn");
    expect(warns).toHaveLength(3);
    expect(warns.map((call) => call.stage)).toEqual(["permissions", "permissions", "permissions"]);
    const warnedStages = warns.map((call) => String(call.data?.stage)).sort((a, b) => a.localeCompare(b));
    expect(warnedStages).toEqual([...INERT_STAGES]);
  });

  test("AC10 boundary: no warnings at all when every declaring stage has its own Bash(...) rule", () => {
    const logger = makeLogger();

    warnInertBashStages(configWithEveryStageGranted("escalate"), logger);

    expect(logger.calls.filter((call) => call.level === "warn")).toHaveLength(0);
  });
});

describe("warnInertBashStages — US-003 AC11: warning data shape", () => {
  test("AC11: each warning carries storyId _setup, the inert stage and bashApproval escalate", () => {
    const logger = makeLogger();

    warnInertBashStages(escalateWithRunGranted(), logger);

    const warns = logger.calls.filter((call) => call.level === "warn");
    for (const stage of INERT_STAGES) {
      const call = warns.find((candidate) => candidate.data?.stage === stage);
      expect(call?.data ?? {}).toMatchObject({ storyId: "_setup", stage, bashApproval: "escalate" });
    }
  });

  test("AC11 boundary: storyId is the first key of the data object (parallel-log correlation)", () => {
    const logger = makeLogger();

    warnInertBashStages(escalateWithRunGranted(), logger);

    const warns = logger.calls.filter((call) => call.level === "warn");
    expect(warns).toHaveLength(3);
    for (const call of warns) {
      expect(Object.keys(call.data ?? {})[0]).toBe("storyId");
    }
  });
});

describe("warnInertBashStages — US-003 AC12: the message names the fix", () => {
  test("AC12: every message contains Bash( — the rule that would fix it", () => {
    const logger = makeLogger();

    warnInertBashStages(escalateWithRunGranted(), logger);

    const warns = logger.calls.filter((call) => call.level === "warn");
    expect(warns).toHaveLength(3);
    for (const call of warns) {
      expect(call.message).toContain("Bash(");
    }
  });

  test("AC12 boundary: each message names its own stage and the mode, not a generic sentence", () => {
    const logger = makeLogger();

    warnInertBashStages(escalateWithRunGranted(), logger);

    const warns = logger.calls.filter((call) => call.level === "warn");
    for (const stage of INERT_STAGES) {
      const call = warns.find((candidate) => candidate.data?.stage === stage);
      expect(call?.message ?? "").toContain(stage);
      expect(call?.message ?? "").toContain("escalate");
    }
  });
});

describe("warnInertBashStages — US-003 AC13: raw is silent", () => {
  test("AC13: a raw config never calls warn", () => {
    const logger = makeLogger();

    warnInertBashStages(makeNaxConfig({ execution: { bashApproval: "raw" } }), logger);

    expect(logger.calls.filter((call) => call.level === "warn")).toHaveLength(0);
  });

  test("AC13 boundary: gated with a Bash(...) rule everywhere is silent too", () => {
    const logger = makeLogger();

    warnInertBashStages(configWithEveryStageGranted("gated"), logger);

    expect(logger.calls.filter((call) => call.level === "warn")).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// setupRun wiring — AC14 / AC15
//
// The warning is emitted at the top of setupRun, so driving the real run is
// what proves the wiring — the assertion is on the logger, not on setupRun's
// result. The surrounding pipeline (runtime, profile detection, transcript
// sweep) is stubbed exactly as the sibling run-setup tests stub it, so the run
// stays hermetic and terminates; whether setup then resolves or throws is
// irrelevant to these two ACs and is swallowed.
// ─────────────────────────────────────────────────────────────────────────────

describe("setupRun — US-003 AC14/AC15: inert-Bash warning at run start", () => {
  const runtimesToClose: NaxRuntime[] = [];
  const workdirsToRemove: string[] = [];

  withDepsRestore(_runSetupDeps);

  afterEach(async () => {
    await Promise.allSettled(runtimesToClose.map((runtime) => runtime.close()));
    runtimesToClose.length = 0;
    for (const workdir of workdirsToRemove) cleanupTempDir(workdir);
    workdirsToRemove.length = 0;
  });

  /** Install the surrounding-pipeline stubs and return a valid PRD path. */
  function installHarness(): { workdir: string; prdPath: string } {
    const workdir = makeTempDir("nax-test-inert-bash-");
    workdirsToRemove.push(workdir);
    const runtime = makeMockRuntime({ workdir });
    runtimesToClose.push(runtime);

    const createRuntimeStub: typeof _runSetupDeps.createRuntime = () => runtime;
    const detectProfileStub: typeof _runSetupDeps.detectProjectProfile = async () => ({});
    const sweepStub: typeof _runSetupDeps.sweepFeatureTranscripts = async () => 0;
    // Real signal handlers on the test process are both non-hermetic and
    // unnecessary here — setupRun only needs a cleanup function back.
    const installCrashHandlersStub: typeof _runSetupDeps.installCrashHandlers = () => () => undefined;

    _runSetupDeps.createRuntime = createRuntimeStub;
    _runSetupDeps.detectProjectProfile = detectProfileStub;
    _runSetupDeps.sweepFeatureTranscripts = sweepStub;
    _runSetupDeps.installCrashHandlers = installCrashHandlersStub;

    const prdPath = join(workdir, "prd.json");
    writeFileSync(
      prdPath,
      JSON.stringify(makePRD({ feature: "inert-bash-feature", userStories: [] }), null, 2),
      "utf8",
    );
    return { workdir, prdPath };
  }

  function makeOptions(workdir: string, prdPath: string, config: NaxConfig): RunSetupOptions {
    return {
      prdPath,
      workdir,
      config,
      hooks: { hooks: {} },
      feature: "inert-bash-feature",
      dryRun: false,
      statusFile: join(workdir, "status.json"),
      runId: `run-inert-bash-${Date.now()}`,
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

  test("AC14: setupRun warns with stage permissions for the inert run stage", async () => {
    const { workdir, prdPath } = installHarness();
    // acceptance.enabled=false keeps initializeRun's agent-install check (a real
    // PATH lookup) out of the run; it is unrelated to what this test asserts.
    const config = makeNaxConfig({
      execution: { bashApproval: "escalate" },
      acceptance: { enabled: false },
    });

    await withWarnSpy(async (warnSpy) => {
      await setupRun(makeOptions(workdir, prdPath, config)).catch(() => {});

      const runWarning = warnSpy.mock.calls.find((call) => call[0] === "permissions" && call[2]?.stage === "run");
      expect(runWarning).toBeDefined();
      expect(runWarning?.[2]).toMatchObject({ storyId: "_setup", stage: "run", bashApproval: "escalate" });
    });
  });

  test("AC15: setupRun logs no permissions warning carrying a bashApproval field under raw", async () => {
    const { workdir, prdPath } = installHarness();
    const config = makeNaxConfig({
      execution: { bashApproval: "raw" },
      acceptance: { enabled: false },
    });

    await withWarnSpy(async (warnSpy) => {
      await setupRun(makeOptions(workdir, prdPath, config)).catch(() => {});

      const offenders = warnSpy.mock.calls.filter(
        (call) => call[0] === "permissions" && call[2]?.bashApproval !== undefined,
      );
      expect(offenders).toHaveLength(0);
    });
  });
});
