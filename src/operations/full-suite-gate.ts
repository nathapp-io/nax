/**
 * Full-Suite Gate Operation
 *
 * Runs full test suite before verifier. Returns structured test failures as
 * findings for the general rectification phase to consume (US-006).
 * Part of US-005: Promotes full-suite gate to first-class orchestrator phase.
 *
 * Converted from RunOperation (LLM-based) to DeterministicOperation in US-005 AC#1.
 * Decision tree:
 * 1. regressionGate.enabled=false → status: "skipped" (issue #1116)
 * 2. Run test suite (via regression() runner for quality-config parity with RegressionStrategy)
 * 3. Tests pass → status: "passed", findings: []
 * 4. Timeout + acceptOnTimeout=true → status: "passed-on-timeout" (BUG-026, issue #1116)
 * 5. Timeout + acceptOnTimeout=false → status: "timeout", success: false
 * 6. Tests fail with structured failures → status: "failed", findings populated
 * 7. Tests fail but parser found 0 structured records → status: "execution-failed", findings: []
 */

import type { NaxConfig } from "../config";
import { rectificationGateConfigSelector } from "../config/selectors";
import { NaxError } from "../errors";
// Leaf import (not the execution barrel) to avoid the execution→operations cycle;
// same file resolves to one module, so the setup registry stays a singleton.
import { maybeRunNewPackageSetup } from "../execution/new-package-setup";
import { executionFailureToFinding, testSummaryToFindings } from "../findings";
import type { Finding } from "../findings/types";
import { getLogger } from "../logger";
import type { UserStory } from "../prd";
import type { TestSummary } from "../test-runners";
import type { CallContext, DeterministicOperation } from "./types";

/**
 * Full-Suite Gate execution status.
 * Statuses disabled/failed-no-rectification/rectification-exhausted removed in US-006.
 * Rectification is now handled externally by the general runFixCycle phase.
 * issue #1116: added "passed-on-timeout" (BUG-026), "timeout", "skipped" (enabled=false).
 */
export type FullSuiteGateStatus =
  | "passed"
  | "failed" // tests failed; findings populated
  | "execution-failed" // runner exited non-zero but parser found 0 structured failures
  | "inconclusive"
  | "passed-on-timeout" // timeout + acceptOnTimeout=true (BUG-026)
  | "timeout" // timeout + acceptOnTimeout=false
  | "skipped"; // regressionGate.enabled=false

/**
 * Input for the full-suite gate.
 */
export interface FullSuiteGateInput {
  readonly story: UserStory;
  readonly workdir: string;
  readonly featureName?: string;
  readonly projectDir?: string;
  readonly lite?: boolean;
  /** Optional pre-resolved test patterns to skip re-resolution inside the gate. */
  readonly resolvedTestPatterns?: import("../test-runners").ResolvedTestPatterns;
}

/**
 * Output from the full-suite gate.
 * `findings` contains structured test failures for the rectification phase.
 */
export interface FullSuiteGateOutput {
  readonly success: boolean;
  readonly passed: boolean;
  readonly status: FullSuiteGateStatus;
  readonly estimatedCostUsd: number;
  readonly durationMs?: number;
  readonly attempts?: number;
  /**
   * Structured test failures for the rectification phase.
   * Empty when tests pass or when the parser returns no structured records (status: "execution-failed").
   */
  readonly findings: Finding[];
  /**
   * Raw test-runner output. Empty when the gate is skipped (regressionGate.enabled=false)
   * or on a clean pass (no failures to triage). Populated on every failure path so callers
   * (flake triage) can run `detectFramework()` without re-running the suite.
   */
  readonly rawOutput: string;
}

const fullSuiteGateConfigSelector = rectificationGateConfigSelector;

// ─────────────────────────────────────────────────────────────────────────────
// Injectable deps for testability (no mock.module() needed)
// ─────────────────────────────────────────────────────────────────────────────

interface RunTestsResult {
  readonly passed: boolean;
  readonly failed: number;
  readonly output: string;
  readonly parsedSummary: TestSummary;
  /** True when the runner returned status=TIMEOUT — let execute() decide accept-on-timeout. */
  readonly timedOut: boolean;
  /** Runner exit code (when known) — surfaced into synthetic findings on execution-failed. */
  readonly exitCode?: number;
  /** Final shell command actually executed (after buildTestCommand wrap) — for synth-finding context. */
  readonly command?: string;
}

/**
 * Resolved gate context — config + test command + timeout resolved once at op entry.
 */
export interface FullSuiteGateContext {
  readonly config: NaxConfig;
  readonly testCmd: string;
  readonly fullSuiteTimeout: number;
  /** cwd for the test subprocess — packageDir when per-package override exists, repoRoot otherwise. */
  readonly cmdWorkdir: string;
}

export interface FullSuiteGateDeps {
  resolveGateContext: (input: FullSuiteGateInput, ctx: CallContext) => Promise<FullSuiteGateContext>;
  runTests: (input: FullSuiteGateInput, gateCtx: FullSuiteGateContext) => Promise<RunTestsResult>;
}

export const _fullSuiteGateDeps: FullSuiteGateDeps = {
  resolveGateContext: async (input, ctx) => {
    const { resolveQualityTestCommands } = await import("../quality/command-resolver");
    const config = ctx.packageView.config; // package-merged config (2b), not root
    // Prefer regressionGate.timeoutSeconds (matches legacy RegressionStrategy / issue #1116)
    // and fall back to rectification.fullSuiteTimeoutSeconds for backwards compatibility with
    // callers that still set the older key.
    const fullSuiteTimeout =
      config.execution?.regressionGate?.timeoutSeconds ??
      config.execution?.rectification?.fullSuiteTimeoutSeconds ??
      300;
    const { testCommand: resolvedTestCmd } = await resolveQualityTestCommands(
      config,
      input.workdir,
      input.story.workdir,
    );
    // Detection fallback: no command configured (root or per-package) — derive one
    // from the package's manifest. Runs from the package dir, since the default was
    // detected there (e.g. a new package's freshly-scaffolded pyproject.toml).
    if (!resolvedTestCmd) {
      const { resolveDefaultQualityCommands } = await import("../quality/command-defaults");
      // input.workdir is the resolved ABSOLUTE package dir (CallContext.packageDir = ctx.workdir).
      // ctx.packageView.packageDir is the RELATIVE key — never probe/spawn against it.
      const detected = (await resolveDefaultQualityCommands(input.workdir)).test;
      if (detected) {
        return { config, testCmd: detected, fullSuiteTimeout, cmdWorkdir: input.workdir };
      }
      const pkg = input.story.workdir ?? input.workdir;
      throw new NaxError(
        `No test command configured or detected for package "${pkg}". Set quality.commands.test in .nax/config.json or .nax/mono/<pkg>/config.json.`,
        "TEST_COMMAND_MISSING",
        {
          stage: "full-suite-gate",
          storyId: input.story.id,
          packageDir: input.story.workdir,
          workdir: input.workdir,
        },
      );
    }
    // Root-config fallback: command was not defined per-package, so run from repo root.
    const cmdWorkdir = ctx.packageView.hasOverride ? input.workdir : ctx.packageView.repoRoot;
    return { config, testCmd: resolvedTestCmd, fullSuiteTimeout, cmdWorkdir };
  },
  runTests: async (_input, gateCtx) => {
    const { regression } = await import("../verification/runners");
    const { parseTestOutput } = await import("../test-runners");
    const result = await regression({
      workdir: gateCtx.cmdWorkdir,
      command: gateCtx.testCmd,
      timeoutSeconds: gateCtx.fullSuiteTimeout,
      // Op decides accept-on-timeout itself; runner stays neutral.
      acceptOnTimeout: false,
      forceExit: gateCtx.config?.quality?.forceExit,
      detectOpenHandles: gateCtx.config?.quality?.detectOpenHandles,
      detectOpenHandlesRetries: gateCtx.config?.quality?.detectOpenHandlesRetries,
      gracePeriodMs: gateCtx.config?.quality?.gracePeriodMs,
      drainTimeoutMs: gateCtx.config?.quality?.drainTimeoutMs,
      shell: gateCtx.config?.quality?.shell,
      stripEnvVars: gateCtx.config?.quality?.stripEnvVars,
    });
    const parsedSummary = parseTestOutput(result.output ?? "");
    return {
      passed: result.success && result.status === "SUCCESS",
      failed: parsedSummary.failed ?? 0,
      output: result.output ?? "",
      parsedSummary,
      timedOut: result.status === "TIMEOUT",
      exitCode: result.exitCode,
      command: result.command ?? gateCtx.testCmd,
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Operation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Full-Suite Gate Operation — DeterministicOperation that runs tests directly.
 *
 * The `deps` third parameter enables test injection via `_deps` pattern.
 * `callOp` calls `op.execute(input, ctx)` with 2 args — `deps` defaults to
 * `_fullSuiteGateDeps` (production wiring). Tests pass custom deps as the third arg.
 *
 * TypeScript structural typing allows extra optional parameters to satisfy the
 * `DeterministicOperation<I,O,C>.execute(input, ctx): Promise<O>` interface.
 */
export const fullSuiteGateOp: DeterministicOperation<
  FullSuiteGateInput,
  FullSuiteGateOutput,
  ReturnType<typeof fullSuiteGateConfigSelector.select>,
  FullSuiteGateDeps
> = {
  kind: "deterministic",
  name: "full-suite-gate",
  stage: "verify",
  config: fullSuiteGateConfigSelector,
  async execute(
    input: FullSuiteGateInput,
    ctx: CallContext,
    deps: FullSuiteGateDeps = _fullSuiteGateDeps,
  ): Promise<FullSuiteGateOutput> {
    const logger = getLogger();
    const ctxConfig = ctx.packageView.config;

    // issue #1116: regressionGate.enabled=false → short-circuit as skipped.
    const enabled = ctxConfig?.execution?.regressionGate?.enabled ?? true;
    if (!enabled) {
      logger.info("verify[regression]", "Regression gate disabled — skipping full-suite run", {
        storyId: input.story.id,
      });
      return {
        success: true,
        passed: true,
        status: "skipped",
        estimatedCostUsd: 0,
        attempts: 0,
        findings: [],
        rawOutput: "",
      };
    }

    const gateCtx = await deps.resolveGateContext(input, ctx);
    // One-time init for a newly-created package (e.g. `uv sync` / `bun install`),
    // now that the implementer has scaffolded the manifest. No-op for existing packages.
    await maybeRunNewPackageSetup({
      runtime: ctx.runtime,
      storyId: input.story.id,
      // Absolute package dir — must match the abs dirs registered via markNewPackageDirs.
      packageDir: input.workdir,
      setupCommand: gateCtx.config.quality?.commands?.setup,
    });
    logger.info("verify[regression]", "Running full-suite gate", {
      storyId: input.story.id,
      packageDir: input.story.workdir,
      cwd: gateCtx.cmdWorkdir,
      command: gateCtx.testCmd,
      timeoutSeconds: gateCtx.fullSuiteTimeout,
    });
    const testResult = await deps.runTests(input, gateCtx);

    if (testResult.passed) {
      return {
        success: true,
        passed: true,
        status: "passed",
        estimatedCostUsd: 0,
        attempts: 0,
        findings: [],
        rawOutput: testResult.output,
      };
    }

    // issue #1116: BUG-026 — timeout + acceptOnTimeout → treat as pass.
    if (testResult.timedOut) {
      const acceptOnTimeout = ctxConfig?.execution?.regressionGate?.acceptOnTimeout ?? true;
      if (acceptOnTimeout) {
        logger.warn("verify[regression]", "[BUG-026] Full-suite timed out (accepted as pass)", {
          storyId: input.story.id,
        });
        return {
          success: true,
          passed: true,
          status: "passed-on-timeout",
          estimatedCostUsd: 0,
          attempts: 0,
          findings: [],
          rawOutput: testResult.output,
        };
      }
      logger.warn("verify[regression]", "Full-suite timed out (failing)", {
        storyId: input.story.id,
      });
      return {
        success: false,
        passed: false,
        status: "timeout",
        estimatedCostUsd: 0,
        attempts: 0,
        findings: [],
        rawOutput: testResult.output,
      };
    }

    const findings = testSummaryToFindings(testResult.parsedSummary);
    if (findings.length === 0) {
      // Runner exited non-zero but parser found 0 structured failures — environmental
      // failure (e.g. config crash, missing dep, wrong cwd). Emit a single synth
      // finding so rectification dispatches the implementer with concrete repair
      // context (command + exit code + output tail) instead of no-oping on 0 findings
      // and silently escalating.
      const cmd = testResult.command ?? gateCtx.testCmd;
      const synth = executionFailureToFinding({
        command: cmd,
        exitCode: testResult.exitCode,
        output: testResult.output,
        packageDir: input.story.workdir,
        cwd: input.workdir,
      });
      logger.warn("verify[regression]", "Full-suite gate execution-failed — emitting synth finding", {
        storyId: input.story.id,
        command: cmd,
        exitCode: testResult.exitCode,
        packageDir: input.story.workdir,
      });
      return {
        success: false,
        passed: false,
        status: "execution-failed",
        estimatedCostUsd: 0,
        attempts: 0,
        findings: [synth],
        rawOutput: testResult.output,
      };
    }

    return {
      success: false,
      passed: false,
      status: "failed",
      estimatedCostUsd: 0,
      attempts: 0,
      findings,
      rawOutput: testResult.output,
    };
  },
};
