/**
 * Full-Suite Gate Operation
 *
 * Runs full test suite before verifier. Returns structured test failures as
 * findings for the general rectification phase to consume (US-006).
 * Part of US-005: Promotes full-suite gate to first-class orchestrator phase.
 *
 * Converted from RunOperation (LLM-based) to DeterministicOperation in US-005 AC#1.
 * Decision tree:
 * 1. Run test suite (always)
 * 2. Tests pass → status: "passed", findings: []
 * 3. Tests fail with structured failures → status: "failed", findings populated
 * 4. Tests fail but parser found 0 structured records → status: "execution-failed", findings: []
 */

import { rectificationGateConfigSelector } from "../config/selectors";
import { testSummaryToFindings } from "../findings";
import type { Finding } from "../findings/types";
import { NaxError } from "../errors";
import type { UserStory } from "../prd";
import type { TestSummary } from "../test-runners";
import type { NaxConfig } from "../config";
import type { CallContext, DeterministicOperation } from "./types";

/**
 * Full-Suite Gate execution status.
 * Statuses disabled/failed-no-rectification/rectification-exhausted removed in US-006.
 * Rectification is now handled externally by the general runFixCycle phase.
 */
export type FullSuiteGateStatus =
  | "passed"
  | "failed"           // tests failed; findings populated
  | "execution-failed" // runner exited non-zero but parser found 0 structured failures
  | "inconclusive";

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
}

/**
 * Resolved gate context — config + test command + timeout resolved once at op entry.
 */
export interface FullSuiteGateContext {
  readonly config: NaxConfig;
  readonly testCmd: string;
  readonly fullSuiteTimeout: number;
}

export interface FullSuiteGateDeps {
  resolveGateContext: (input: FullSuiteGateInput, ctx: CallContext) => Promise<FullSuiteGateContext>;
  runTests: (input: FullSuiteGateInput, gateCtx: FullSuiteGateContext) => Promise<RunTestsResult>;
}

export const _fullSuiteGateDeps: FullSuiteGateDeps = {
  resolveGateContext: async (input, ctx) => {
    const { resolveQualityTestCommands } = await import("../quality/command-resolver");
    const config = ctx.runtime.configLoader.current();
    const fullSuiteTimeout = config.execution?.rectification?.fullSuiteTimeoutSeconds ?? 60;
    const { testCommand: resolvedTestCmd } = await resolveQualityTestCommands(
      config,
      input.workdir,
      input.story.workdir,
    );
    if (!resolvedTestCmd) {
      const pkg = input.story.workdir ?? input.workdir;
      throw new NaxError(
        `No test command configured for package "${pkg}". Set quality.commands.test in .nax/config.json or .nax/mono/<pkg>/config.json.`,
        "TEST_COMMAND_MISSING",
        {
          stage: "full-suite-gate",
          storyId: input.story.id,
          packageDir: input.story.workdir,
          workdir: input.workdir,
        },
      );
    }
    return { config, testCmd: resolvedTestCmd, fullSuiteTimeout };
  },
  runTests: async (input, gateCtx) => {
    const { executeWithTimeout, parseTestOutput } = await import("../verification");
    const result = await executeWithTimeout(gateCtx.testCmd, gateCtx.fullSuiteTimeout, undefined, {
      cwd: input.workdir,
    });
    const parsedSummary = parseTestOutput(result.output ?? "");
    return {
      passed: result.success && result.exitCode === 0,
      failed: parsedSummary.failed ?? 0,
      output: result.output ?? "",
      parsedSummary,
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
  ReturnType<typeof fullSuiteGateConfigSelector.select>
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
    const gateCtx = await deps.resolveGateContext(input, ctx);
    const testResult = await deps.runTests(input, gateCtx);

    if (testResult.passed) {
      return { success: true, passed: true, status: "passed", estimatedCostUsd: 0, attempts: 0, findings: [] };
    }

    const findings = testSummaryToFindings(testResult.parsedSummary);
    if (findings.length === 0) {
      // Runner exited non-zero but parser found 0 structured failures — environmental failure.
      return { success: false, passed: false, status: "execution-failed", estimatedCostUsd: 0, attempts: 0, findings: [] };
    }

    return { success: false, passed: false, status: "failed", estimatedCostUsd: 0, attempts: 0, findings };
  },
};
