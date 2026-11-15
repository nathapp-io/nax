/**
 * Gate entry points wired to the resolved stall policy (review-and-gate-guards US-008).
 *
 * Every case here asserts the value that arrives where a command is actually
 * executed — the quality runner's options, the scoped-lint helper boundary, the
 * review runner's check call, setup's verification command, the bot's gate
 * projection and `nax gates run`'s report. Nothing in this file reads the policy
 * back out of configuration: a consumer that re-derived it would pass the
 * default instead of the value asserted below.
 *
 * Policy mappings stay real (a distinctive `repeatedLineThreshold`, so no schema
 * default can satisfy an assertion); only process spawning, timers and
 * LLM-backed results are doubled.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  cleanupTempDir,
  type DeepPartial,
  makeBotFixEnv,
  makeConfigSlice,
  makeFakeClock,
  makeMockCallContext,
  makeNaxConfig,
  makeSpawn,
  makeStepContext,
  makeTempDir,
  makeTestRuntime,
  stalledProc,
} from "@test/helpers";
import {
  _botChecksDeps,
  _fixStepsDeps,
  _gateBaselineDeps,
  type BotCheck,
  failingOnHead,
  gatesStep,
  resolveBotChecks,
} from "@/bot";
import { type GatesCliDeps, type GatesRunReport, gatesRunCommand } from "@/cli";
import { runSetupGate } from "@/cli/setup-verify";
import { DEFAULT_CONFIG, type NaxConfig } from "@/config";
import { _qualityGateDeps, DEFAULT_GATE_TAIL_LINES, type QualityGateResult, runQualityGates } from "@/finish";
import type { GateCommand } from "@/finish/gates/quality";
import { _lintCheckDeps } from "@/operations/lint-check";
import { _typecheckCheckDeps } from "@/operations/typecheck-check";
import type { QualityCommandOptions, QualityCommandResult } from "@/quality";
import { _qualityRunnerDeps } from "@/quality/runner";
import { _reviewGitDeps, _reviewLintDeps, _reviewRunnerDeps, runReview } from "@/review/runner";
import { _scopedLintDeps, runScopedLintCheck } from "@/review/scoped-lint";
import type { ReviewConfig } from "@/review/types";
import { DEFAULT_GATE_STALL_POLICY, type GateStallPolicy, type GateStopReason } from "@/utils/gate-stall";
import { runStoryGates } from "@/workflow/gates";
import { _workflowDeps, type StepContext } from "@/workflow/step-context";

/** A policy no schema default and no fixed-branch config can produce. */
const POLICY: GateStallPolicy = { repeatedLineThreshold: 7, silenceTimeoutSeconds: 13 };

/** How many equal lines the stalled child emits: past the policy's threshold of 7. */
const REPEAT_COUNT = 9;

/** The evidence a detector leaves behind when it stops a repeating command. */
const STOPPED_REASON: GateStopReason = {
  kind: "repeated-output",
  stream: "stdout",
  count: REPEAT_COUNT,
  threshold: POLICY.repeatedLineThreshold,
};

const ORIGINAL_LINT = { ..._lintCheckDeps };
const ORIGINAL_TYPECHECK = { ..._typecheckCheckDeps };
const ORIGINAL_WORKFLOW = { ..._workflowDeps };
const ORIGINAL_RUNNER = { ..._qualityRunnerDeps };
const ORIGINAL_REVIEW_GIT = { ..._reviewGitDeps };
const ORIGINAL_REVIEW_LINT = { ..._reviewLintDeps };
const ORIGINAL_REVIEW_RUNNER = { ..._reviewRunnerDeps };
const ORIGINAL_SCOPED_LINT = { ..._scopedLintDeps };
const ORIGINAL_BOT = { ..._botChecksDeps };
const ORIGINAL_FIX_STEPS = { ..._fixStepsDeps };
const ORIGINAL_GATE_BASELINE = { ..._gateBaselineDeps };
const ORIGINAL_QUALITY_GATE = { ..._qualityGateDeps };

afterEach(() => {
  Object.assign(_lintCheckDeps, ORIGINAL_LINT);
  Object.assign(_typecheckCheckDeps, ORIGINAL_TYPECHECK);
  Object.assign(_workflowDeps, ORIGINAL_WORKFLOW);
  Object.assign(_qualityRunnerDeps, ORIGINAL_RUNNER);
  Object.assign(_reviewGitDeps, ORIGINAL_REVIEW_GIT);
  Object.assign(_reviewLintDeps, ORIGINAL_REVIEW_LINT);
  Object.assign(_reviewRunnerDeps, ORIGINAL_REVIEW_RUNNER);
  Object.assign(_scopedLintDeps, ORIGINAL_SCOPED_LINT);
  Object.assign(_botChecksDeps, ORIGINAL_BOT);
  Object.assign(_fixStepsDeps, ORIGINAL_FIX_STEPS);
  Object.assign(_gateBaselineDeps, ORIGINAL_GATE_BASELINE);
  Object.assign(_qualityGateDeps, ORIGINAL_QUALITY_GATE);
});

function commandText(opts: QualityCommandOptions): string {
  return typeof opts.command === "string" ? opts.command : opts.command.join(" && ");
}

/** A green quality-runner result for one command. */
function greenResult(opts: QualityCommandOptions): QualityCommandResult {
  return {
    commandName: opts.commandName,
    command: commandText(opts),
    success: true,
    exitCode: 0,
    output: "",
    durationMs: 1,
    timedOut: false,
  };
}

/** A detector-stopped quality-runner result for one command. */
function stoppedResult(opts: QualityCommandOptions): QualityCommandResult {
  return {
    commandName: opts.commandName,
    command: commandText(opts),
    success: false,
    exitCode: -1,
    output: `[nax] ${opts.commandName} stopped early: repeated-output on stdout`,
    durationMs: 1,
    timedOut: true,
    stopReason: STOPPED_REASON,
  };
}

/**
 * Replace both mechanical ops' quality runner with one recorder. Returns the
 * recorded options in call order.
 */
function recordRunner(result: (opts: QualityCommandOptions) => QualityCommandResult = greenResult) {
  const calls: QualityCommandOptions[] = [];
  const stub = async (opts: QualityCommandOptions): Promise<QualityCommandResult> => {
    calls.push(opts);
    return result(opts);
  };
  _lintCheckDeps.runQualityCommand = stub;
  _typecheckCheckDeps.runQualityCommand = stub;
  return calls;
}

/** A step context whose package view carries `quality`. */
function stepWith(workdir: string, quality: DeepPartial<NaxConfig["quality"]>): StepContext {
  const config = makeNaxConfig({ quality });
  return makeStepContext({
    callCtx: makeMockCallContext({ runtime: makeTestRuntime({ config }) }),
    config,
    workdir,
    projectDir: workdir,
  });
}

// ---------------------------------------------------------------------------
// AC-1…5 — the package view's policy reaches each mechanical gate
// ---------------------------------------------------------------------------

describe("runStoryGates — the package view's policy reaches each mechanical gate", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir("nax-us008-gates-");
  });
  afterEach(() => {
    cleanupTempDir(dir);
  });

  test("AC-1: a manifest-detected lint command runs under the package-view policy", async () => {
    // No configured lint command: the op derives one from the package's manifest,
    // so the policy has to come from the package view rather than from the
    // `quality.commands.lint` entry the detection path never saw.
    await Bun.write(`${dir}/package.json`, JSON.stringify({ name: "pkg", version: "1.0.0" }));
    await Bun.write(`${dir}/biome.json`, "{}");
    const calls = recordRunner();

    await runStoryGates(stepWith(dir, { stallDetection: POLICY }));

    const lint = calls.find((call) => call.commandName === "lint");
    expect(lint?.stallDetection).toEqual(POLICY);
    // Provenance resolved: a detected command runs from the package dir.
    expect(lint?.workdir).toBe(dir);
    expect(lint?.command).toContain("biome check");
  });

  test("AC-2: a stopped lint command is reported in GateRunResult.timedOut", async () => {
    recordRunner(stoppedResult);

    const result = await runStoryGates(stepWith(dir, { commands: { lint: "npm run lint" }, stallDetection: POLICY }));

    expect(result.states.lint).toBe("red");
    expect(result.timedOut).toEqual(["lint"]);
    // The lint op's own partial-output sentinel says the run was interrupted, so a
    // fix prompt never reads the fragment as the linter's whole verdict.
    expect(result.findings.some((finding) => finding.issue.includes("interrupted"))).toBe(true);
  });

  test("AC-3: typecheck runs under the package-view policy", async () => {
    const calls = recordRunner();

    await runStoryGates(stepWith(dir, { commands: { typecheck: "npm run typecheck" }, stallDetection: POLICY }));

    const typecheck = calls.find((call) => call.commandName === "typecheck");
    expect(typecheck?.stallDetection).toEqual(POLICY);
  });

  test("AC-4: a stopped typecheck command is reported in GateRunResult.timedOut", async () => {
    recordRunner(stoppedResult);

    const result = await runStoryGates(stepWith(dir, { commands: { typecheck: "npm run typecheck" } }));

    expect(result.states.typecheck).toBe("red");
    expect(result.timedOut).toEqual(["typecheck"]);
  });

  test("AC-5: a green gate stays out of the timed-out list beside a stopped one", async () => {
    _lintCheckDeps.runQualityCommand = async (opts) => greenResult(opts);
    _typecheckCheckDeps.runQualityCommand = async (opts) =>
      opts.commandName === "typecheck" ? stoppedResult(opts) : greenResult(opts);

    const result = await runStoryGates(stepWith(dir, { commands: { lint: "npm run lint", typecheck: "tsc" } }));

    expect(result.states.lint).toBe("green");
    expect(result.states.typecheck).toBe("red");
    expect(result.timedOut).toEqual(["typecheck"]);
  });
});

// ---------------------------------------------------------------------------
// AC-21 — a detector stop is gate evidence, not a silent partial run
// ---------------------------------------------------------------------------

describe("runStoryGates — a detector stop surfaces as gate evidence (AC-21)", () => {
  let dir: string;
  let clock: ReturnType<typeof makeFakeClock>;

  beforeEach(() => {
    dir = makeTempDir("nax-us008-stall-");
    clock = makeFakeClock();
    _qualityRunnerDeps.setTimeout = clock.setTimeout;
    _qualityRunnerDeps.clearTimeout = (handle) => clock.clearTimeout(typeof handle === "number" ? handle : undefined);
    // A detached group is signalled, never a real pid: the stub answers the probe.
    _qualityRunnerDeps.killProcessGroup = () => false;
    // The live child repeats one line and its exit never settles.
    _qualityRunnerDeps.spawn = makeSpawn(() => stalledProc("stdout", REPEAT_COUNT)).spawn;
  });
  afterEach(() => {
    cleanupTempDir(dir);
  });

  test("AC-21: the timeout finding names the reason instead of trusting the partial run", async () => {
    const pending = runStoryGates(stepWith(dir, { commands: { lint: "npm run lint" }, stallDetection: POLICY }));
    let done = false;
    const tracked = pending.then((value) => {
      done = true;
      return value;
    });
    // Walk the virtual clock so the bounded grace period and drains cost no wall time.
    for (let step = 0; step < 200 && !done; step++) await clock.advance(1_000);
    const result = await tracked;

    expect(result.states.lint).toBe("red");
    expect(result.timedOut).toEqual(["lint"]);
    const issues = result.findings.map((finding) => finding.issue);
    expect(issues.some((issue) => issue.includes("stopped early"))).toBe(true);
    expect(issues.some((issue) => issue.includes("stdout repeated the same line"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-6…9 — the review runner and the scoped-lint helper boundary
// ---------------------------------------------------------------------------

/** A full config whose `quality.stallDetection` is the policy under test. */
function naxConfigWith(policy: GateStallPolicy): NaxConfig {
  return { ...DEFAULT_CONFIG, quality: { ...DEFAULT_CONFIG.quality, stallDetection: policy } };
}

function reviewChecks(checks: ReviewConfig["checks"], commands: ReviewConfig["commands"]): ReviewConfig {
  return makeConfigSlice("review", { enabled: true, checks, commands });
}

describe("runReview — the config's policy crosses the check boundary", () => {
  beforeEach(() => {
    _reviewGitDeps.getUncommittedFiles = async () => [];
  });

  test("AC-6: mechanical checks receive the provided config policy", async () => {
    const lintArgs: Parameters<typeof _reviewLintDeps.runScopedLintCheck>[0][] = [];
    _reviewLintDeps.runScopedLintCheck = async (args) => {
      lintArgs.push(args);
      return { check: "lint", command: "lint", success: true, exitCode: 0, output: "", durationMs: 1 };
    };
    const runner: QualityCommandOptions[] = [];
    _reviewRunnerDeps.runQualityCommand = async (opts) => {
      runner.push(opts);
      return greenResult(opts);
    };

    await runReview({
      config: reviewChecks(["lint"], { lint: "eslint ." }),
      workdir: "/tmp/review",
      naxConfig: naxConfigWith(POLICY),
    });
    await runReview({
      config: reviewChecks(["typecheck"], { typecheck: "tsc --noEmit" }),
      workdir: "/tmp/review",
      naxConfig: naxConfigWith(POLICY),
    });

    expect(lintArgs[0]?.stallDetection).toEqual(POLICY);
    expect(runner[0]?.stallDetection).toEqual(POLICY);
  });

  test("AC-9: without a full config the check gets the schema-derived policy", async () => {
    const lintArgs: Parameters<typeof _reviewLintDeps.runScopedLintCheck>[0][] = [];
    _reviewLintDeps.runScopedLintCheck = async (args) => {
      lintArgs.push(args);
      return { check: "lint", command: "lint", success: true, exitCode: 0, output: "", durationMs: 1 };
    };
    const runner: QualityCommandOptions[] = [];
    _reviewRunnerDeps.runQualityCommand = async (opts) => {
      runner.push(opts);
      return greenResult(opts);
    };

    await runReview({ config: reviewChecks(["lint"], { lint: "eslint ." }), workdir: "/tmp/review" });
    await runReview({ config: reviewChecks(["typecheck"], { typecheck: "tsc --noEmit" }), workdir: "/tmp/review" });

    // Not `undefined`: an absent config must enable the detector on schema defaults,
    // never disable it.
    expect(lintArgs[0]?.stallDetection).toEqual(DEFAULT_GATE_STALL_POLICY);
    expect(runner[0]?.stallDetection).toEqual(DEFAULT_GATE_STALL_POLICY);
  });
});

/** Every scoped-lint arm the design names, as the arguments that select it. */
type ScopedArgs = Parameters<typeof runScopedLintCheck>[0];

function scopedArgs(overrides: Partial<ScopedArgs> = {}): ScopedArgs {
  return {
    resolvedLintCommand: "eslint --max-warnings=0",
    configCommands: {},
    qualityCommands: {},
    workdir: "/repo",
    storyId: "US-001",
    scope: { changedFiles: ["src/a.ts"], contextFiles: [], packageDir: "." },
    stallDetection: POLICY,
    ...overrides,
  };
}

describe("runScopedLintCheck — every arm carries the same policy", () => {
  beforeEach(() => {
    _scopedLintDeps.fileExists = async () => true;
  });

  test("AC-7: template, full-lint and degraded paths pass the same policy", async () => {
    const seen: (Partial<GateStallPolicy> | undefined)[] = [];
    _scopedLintDeps.runLintCommand = async (_workdir, _storyId, _env, _command, _stripEnvVars, stallDetection) => {
      seen.push(stallDetection);
      return greenResult({ commandName: "lint", command: "lint", workdir: "/repo" });
    };

    const arms: ScopedArgs[] = [
      // Template arm: `lintScoped` with `{{files}}`.
      scopedArgs({ configCommands: { lintScoped: "biome check {{files}}" } }),
      // Full-lint arm: no template and no supported derived shape, so the whole
      // command runs and its diagnostics are scoped afterwards.
      scopedArgs({ resolvedLintCommand: "make lint" }),
      // Degraded arm: the scope cannot be resolved at all, so the full command runs.
      scopedArgs({ resolvedLintCommand: "make lint", scope: undefined }),
    ];
    for (const args of arms) await runScopedLintCheck(args);

    expect(seen).toEqual([POLICY, POLICY, POLICY]);
  });

  test("AC-8: the derived arm passes the policy at command execution, with the scoped command", async () => {
    // The real `runLintCommand` stays in place: the policy has to survive the
    // helper boundary and reach the quality runner, not just the helper call.
    const runner: QualityCommandOptions[] = [];
    _scopedLintDeps.runQualityCommand = async (opts) => {
      runner.push(opts);
      return greenResult(opts);
    };

    await runScopedLintCheck(scopedArgs());

    expect(runner).toHaveLength(1);
    expect(runner[0]?.stallDetection).toEqual(POLICY);
    expect(runner[0]?.command).toBe("eslint --max-warnings=0 'src/a.ts'");
  });
});

// ---------------------------------------------------------------------------
// AC-10…11 — setup verification
// ---------------------------------------------------------------------------

/** A full config whose `quality.commands.test` and policy are the ones under test. */
function setupConfig(command = "npm test"): NaxConfig {
  return {
    ...DEFAULT_CONFIG,
    quality: { ...DEFAULT_CONFIG.quality, commands: { test: command }, stallDetection: POLICY },
  };
}

/**
 * Record every policy that reaches the stall monitor the runner creates. The
 * runner creates one only when a caller passed a policy, so an empty list is
 * "no detector" — the exact failure AC-9/AC-10 are about.
 */
function captureMonitorPolicies(): GateStallPolicy[] {
  const policies: GateStallPolicy[] = [];
  const createMonitor = ORIGINAL_RUNNER.createGateStallMonitor;
  _qualityRunnerDeps.createGateStallMonitor = (options) => {
    policies.push(options.policy);
    return createMonitor(options);
  };
  return policies;
}

describe("runSetupGate — the config's policy reaches the verification command", () => {
  test("AC-10: forwards the supplied config policy to its verification command", async () => {
    _qualityRunnerDeps.spawn = makeSpawn(() => "all tests passed").spawn;
    const policies = captureMonitorPolicies();

    const code = await runSetupGate("/tmp/nax-us008-setup", setupConfig());

    expect(policies).toEqual([POLICY]);
    expect(code).toBe(0);
  });

  test("AC-11: a stopped verification command returns the existing nonzero result", async () => {
    const clock = makeFakeClock();
    _qualityRunnerDeps.setTimeout = clock.setTimeout;
    _qualityRunnerDeps.clearTimeout = (handle) => clock.clearTimeout(typeof handle === "number" ? handle : undefined);
    _qualityRunnerDeps.killProcessGroup = () => false;
    _qualityRunnerDeps.spawn = makeSpawn(() => stalledProc("stdout", REPEAT_COUNT)).spawn;
    captureMonitorPolicies();

    const pending = runSetupGate("/tmp/nax-us008-setup", setupConfig("repeating test command"));
    let done = false;
    const tracked = pending.then((value) => {
      done = true;
      return value;
    });
    let steps = 0;
    for (; steps < 200 && !done; steps++) await clock.advance(1_000);

    // The detector stopped the child at the configured repetition count, so the
    // run settles long before the 120 s wall deadline is reached.
    expect(steps).toBeLessThan(10);
    // The runner's existing stopped result: exitCode -1, unchanged by US-008.
    expect(await tracked).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// AC-12…14 — the bot's trusted gate projections
// ---------------------------------------------------------------------------

/** The policy the base snapshot's own config resolves — deliberately not `POLICY`. */
const SNAPSHOT_POLICY: GateStallPolicy = { repeatedLineThreshold: 21, silenceTimeoutSeconds: 3 };

describe("resolveBotChecks — trusted gates carry a policy", () => {
  let files: Record<string, string>;
  let input: Parameters<typeof resolveBotChecks>[0];

  beforeEach(() => {
    files = {};
    input = {
      repoRoot: "/repo",
      baseSha: "base-sha",
      snapshotDir: "/snap",
      hasBaseNax: false,
      // The trusted input config's policy — never an LLM-extracted threshold.
      config: makeNaxConfig({ quality: { stallDetection: POLICY } }),
      extract: async () => ({ gates: [{ gate: "test", command: "bun run test" }] }),
    };
    _botChecksDeps.resolveGateCommands = async () => [];
    _botChecksDeps.runGit = async (args) => {
      const path = args[0] === "ls-tree" ? (args[5] ?? "") : (args[1] ?? "").replace("base-sha:", "");
      return {
        exitCode: 0,
        stdout: args[0] === "ls-tree" ? (path in files ? `${path}\0` : "") : (files[path] ?? ""),
        stderr: "",
      };
    };
  });
  afterEach(() => {
    Object.assign(_botChecksDeps, ORIGINAL_BOT);
  });

  test("AC-12: a configured gate keeps the policy the snapshot's own resolution gave it", async () => {
    input.hasBaseNax = true;
    _botChecksDeps.resolveGateCommands = async () => [
      { name: "lint", command: "bun run lint", cwd: "/snap", stallDetection: SNAPSHOT_POLICY },
    ];

    const checks = await resolveBotChecks(input);

    expect(checks.source).toBe("config");
    expect(checks.gates[0]?.stallDetection).toEqual(SNAPSHOT_POLICY);
  });

  test("AC-13: an instruction-derived gate gets the trusted input config's policy", async () => {
    files["AGENTS.md"] = "run the checks";

    const checks = await resolveBotChecks(input);

    expect(checks.source).toBe("agents-md");
    expect(checks.gates[0]?.stallDetection).toEqual(POLICY);
  });

  test("AC-14: a detection-derived gate gets the same trusted policy", async () => {
    files["package.json"] = JSON.stringify({ scripts: { test: "bun test" } });

    const checks = await resolveBotChecks(input);

    expect(checks.source).toBe("detected");
    expect(checks.gates[0]?.stallDetection).toEqual(POLICY);
  });
});

// ---------------------------------------------------------------------------
// AC-15…17 — the bot's gate runs keep the reviewed policy
// ---------------------------------------------------------------------------

/**
 * The bot's reviewed gates, projected by the real `resolveBotChecks` from the
 * trusted base snapshot — so the policy under test arrives the way production
 * gets it, not as a hand-built literal.
 */
async function reviewedGates(): Promise<readonly BotCheck[]> {
  const files: Record<string, string> = { "package.json": JSON.stringify({ scripts: { test: "npm test" } }) };
  _botChecksDeps.runGit = async (args) => {
    const path = args[0] === "ls-tree" ? (args[5] ?? "") : (args[1] ?? "").replace("base-sha:", "");
    return {
      exitCode: 0,
      stdout: args[0] === "ls-tree" ? (path in files ? `${path}\0` : "") : (files[path] ?? ""),
      stderr: "",
    };
  };
  // The trusted snapshot is the only place the bot reads a gate from.
  const checks = await resolveBotChecks({
    repoRoot: "/repo",
    baseSha: "base-sha",
    snapshotDir: "/snap",
    hasBaseNax: false,
    config: makeNaxConfig({ quality: { stallDetection: POLICY } }),
    extract: async () => null,
  });
  return checks.gates;
}

describe("bot gate steps — the reviewed policy survives the remap", () => {
  beforeEach(() => {
    _fixStepsDeps.runGit = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    _gateBaselineDeps.runGit = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    _gateBaselineDeps.readHead = async () => "fix-sha";
  });

  test("AC-15: gatesStep keeps the reviewed policy while mapping the checkout worktree", async () => {
    const run = mock(
      async (_worktree: string, _commands: readonly GateCommand[]): Promise<QualityGateResult> => ({
        passed: true,
        failing: [],
        ran: ["test"],
        output: "",
      }),
    );
    _fixStepsDeps.runQualityGates = run;
    const env = makeBotFixEnv();
    const gates = await reviewedGates();
    const withGates = { ...env, checks: { ...env.checks, gates } };

    const result = await gatesStep(withGates, { step: "gates", timings: {} });

    expect(result).toEqual({ exit: "passed", patch: {} });
    expect(run).toHaveBeenCalledWith(
      env.checkout.worktree,
      gates.map((gate) => ({ ...gate, cwd: env.checkout.worktree })),
      { onGate: expect.any(Function) },
    );
    expect(run.mock.calls[0]?.[1][0]?.stallDetection).toEqual(POLICY);
  });

  test("AC-16: failingOnHead keeps the reviewed policy on the unmodified head", async () => {
    const run = mock(async (_worktree: string, _gates: readonly GateCommand[]) => ({
      passed: false,
      failing: ["test"],
      ran: ["test"],
      output: "",
    }));
    _gateBaselineDeps.runQualityGates = run;
    const gates: GateCommand[] = (await reviewedGates()).map((gate) => ({ ...gate, cwd: "/worktree" }));

    expect(await failingOnHead("/worktree", "h1", gates)).toEqual(["test"]);

    expect(run).toHaveBeenCalledWith("/worktree", gates, { onGate: expect.any(Function) });
    expect(run.mock.calls[0]?.[1][0]?.stallDetection).toEqual(POLICY);
  });

  test("AC-17: neither step rereads the policy from the fixed tree", async () => {
    // Both steps run the REAL `runQualityGates`; only the command runner is doubled.
    // Reloading configuration to find the policy again would hit these and throw.
    let reads = 0;
    _qualityGateDeps.loadConfig = async () => {
      reads++;
      throw new Error("config reread");
    };
    _qualityGateDeps.loadPackageOverride = async () => {
      reads++;
      throw new Error("config reread");
    };
    const ran: QualityCommandOptions[] = [];
    _qualityGateDeps.run = async (opts) => {
      ran.push(opts);
      return greenResult(opts);
    };
    const env = makeBotFixEnv();
    const gates = await reviewedGates();
    const withGates = { ...env, checks: { ...env.checks, gates } };
    const headGates: GateCommand[] = gates.map((gate) => ({ ...gate, cwd: "/worktree" }));

    expect(await gatesStep(withGates, { step: "gates", timings: {} })).toEqual({ exit: "passed", patch: {} });
    expect(await failingOnHead("/worktree", "h1", headGates)).toEqual([]);

    expect(reads).toBe(0);
    expect(ran.map((opts) => opts.stallDetection)).toEqual([POLICY, POLICY]);
  });
});

// ---------------------------------------------------------------------------
// AC-18…20 — `nax gates run` exposes the stop evidence
// ---------------------------------------------------------------------------

/** The notice the quality runner writes for a detector stop. */
const STOPPED_OUTPUT = `[nax] lint stopped early: repeated-output on stdout (line repeated ${REPEAT_COUNT} times, threshold ${POLICY.repeatedLineThreshold})`;

describe("gatesRunCommand — a stopped gate is reported, not hidden", () => {
  let dir: string;
  let out: string[];
  let err: string[];

  beforeEach(async () => {
    dir = makeTempDir("nax-us008-cli-");
    await Bun.write(`${dir}/.nax/config.json`, "{}");
    out = [];
    err = [];
    // The real `runQualityGates`; only the command runner is doubled, so the
    // record, its status and the report entry are the production ones.
    _qualityGateDeps.run = async (opts) => ({
      ...stoppedResult(opts),
      commandName: "lint",
      exitCode: -1,
      timedOut: true,
      output: STOPPED_OUTPUT,
    });
  });
  afterEach(() => {
    cleanupTempDir(dir);
  });

  /** Run `nax gates run` with the production report path over one stopped gate. */
  async function runGates(json: boolean): Promise<number> {
    const deps: GatesCliDeps = {
      log: (msg) => out.push(msg),
      logErr: (msg) => err.push(msg),
      exit: () => {},
      isInteractive: () => false,
      ensureProjectTrusted: async () => {},
      resolveGateCommands: async () => [{ name: "lint", command: "npm run lint", cwd: dir, stallDetection: POLICY }],
      runQualityGates,
    };
    return await gatesRunCommand({ dir, gates: [], json }, deps);
  }

  test("AC-18: a stopped configured gate exits 2", async () => {
    expect(await runGates(false)).toBe(2);
  });

  test("AC-19: --json writes one document carrying the gate's structured stopReason", async () => {
    await runGates(true);

    expect(out).toHaveLength(1);
    const report: GatesRunReport = JSON.parse(out[0] ?? "");
    expect(report.passed).toBe(false);
    expect(report.gates[0]?.status).toBe("timed-out");
    expect(report.gates[0]?.stopReason).toEqual(STOPPED_REASON);
  });

  test("AC-20: plain output shows the reason in that gate's output", async () => {
    await runGates(false);

    // The gate's own summary line names the detector evidence...
    expect(out[0]).toContain("stopped early");
    expect(out[0]).toContain("repeated-output on stdout");
    // ...and its captured output is printed under the gate's own header.
    const tail = out.slice(out.indexOf(`--- lint (last ${DEFAULT_GATE_TAIL_LINES} lines) ---`) + 1);
    expect(tail).toContain(STOPPED_OUTPUT);
  });
});
