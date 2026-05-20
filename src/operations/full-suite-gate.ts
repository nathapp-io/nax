/**
 * Full-Suite Gate Operation
 *
 * Runs full test suite before verifier. Detects regressions and optionally
 * triggers rectification loop.
 * Part of US-005: Promotes full-suite gate to first-class orchestrator phase.
 *
 * Converted from RunOperation (LLM-based) to DeterministicOperation in US-005 AC#1.
 * Decision tree:
 * 1. Run test suite (always — never skip based on rectification config)
 * 2. Tests pass → status: "passed", success: true
 * 3. Tests fail + rectification disabled → status: "failed-no-rectification", success: false
 *    (Critical fix: old code returned "disabled" BEFORE running tests, causing TDD halt regression)
 * 4. Tests fail + rectification enabled → enter rectification loop
 * 5. Loop fixes → status: "passed", success: true
 * 6. Loop exhausts → status: "rectification-exhausted", success: false
 */

import type { ModelTier, NaxConfig } from "../config";
import { rectificationGateConfigSelector } from "../config/selectors";
import { NaxError } from "../errors";
import type { UserStory } from "../prd";
import { runRectificationLoop } from "../tdd";
import type { CallContext, DeterministicOperation } from "./types";

/**
 * Full-Suite Gate execution status.
 * "disabled" is removed — tests always run first; rectification config only
 * determines what happens AFTER test failure.
 */
export type FullSuiteGateStatus =
  | "passed"
  | "rectification-exhausted"
  | "failed-no-rectification" // tests failed, rectification was disabled
  | "execution-failed"
  | "inconclusive";

/**
 * Input for the full-suite gate.
 * Contains story, workdir, and optional config overrides for test execution.
 */
export interface FullSuiteGateInput {
  readonly story: UserStory;
  readonly workdir: string;
  readonly featureName?: string;
  readonly projectDir?: string;
  readonly rectificationEnabled?: boolean; // undefined defaults to false
  readonly implementerTier?: ModelTier; // model tier for rectification agent session
  readonly lite?: boolean; // skip isolation checks during rectification
  /** Optional pre-resolved test patterns to skip re-resolution inside the gate. */
  readonly resolvedTestPatterns?: import("../test-runners").ResolvedTestPatterns;
}

/**
 * Output from the full-suite gate.
 * Includes status classification and optional rectification attempts.
 * `passed` field is preserved for backward compat with post-run.ts → ctx.fullSuiteGatePassed.
 */
export interface FullSuiteGateOutput {
  readonly success: boolean; // true when passed; false on any failure
  readonly passed: boolean; // true only when tests actually passed (kept for post-run ctx.fullSuiteGatePassed)
  readonly status: FullSuiteGateStatus;
  readonly estimatedCostUsd: number; // always 0; real cost flows through DispatchEvent → CostAggregator
  readonly durationMs?: number; // populated when timing is available
  readonly attempts?: number; // populated when rectification runs (0 when tests pass directly)
}

const fullSuiteGateConfigSelector = rectificationGateConfigSelector;

// ─────────────────────────────────────────────────────────────────────────────
// Injectable deps for testability (no mock.module() needed)
// ─────────────────────────────────────────────────────────────────────────────

interface RunTestsResult {
  readonly passed: boolean;
  readonly failed: number;
  readonly output: string;
}

interface RunRectificationResult {
  readonly exhausted: boolean;
  readonly attempts: number;
  readonly fixedAll?: boolean;
}

/**
 * Resolved gate context — config + test command + timeout resolved once at op entry
 * so runTests and runRectificationLoop share the same values without duplicating
 * configLoader/resolveQualityTestCommands calls (US-005 review M3).
 */
export interface FullSuiteGateContext {
  readonly config: NaxConfig;
  readonly testCmd: string;
  readonly fullSuiteTimeout: number;
}

export interface FullSuiteGateDeps {
  resolveGateContext: (input: FullSuiteGateInput, ctx: CallContext) => Promise<FullSuiteGateContext>;
  runTests: (input: FullSuiteGateInput, gateCtx: FullSuiteGateContext) => Promise<RunTestsResult>;
  runRectificationLoop: (
    input: FullSuiteGateInput,
    ctx: CallContext,
    gateCtx: FullSuiteGateContext,
    testOutput: string,
  ) => Promise<RunRectificationResult>;
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
    // US-005 review M2: do not silently default to "bun test" — fail loudly when
    // the package has no resolvable test command. The outermost pipeline boundary
    // (run-regression.ts) is the only legal site for a `?? "bun test"` fallback.
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
    const parsed = parseTestOutput(result.output ?? "");
    return {
      passed: result.success && result.exitCode === 0,
      failed: parsed.failed ?? 0,
      output: result.output ?? "",
    };
  },
  runRectificationLoop: async (input, ctx, gateCtx, testOutput) => {
    const { parseTestOutput } = await import("../verification");
    const testSummary = parseTestOutput(testOutput);
    const result = await runRectificationLoop({
      story: input.story,
      config: gateCtx.config,
      workdir: input.workdir,
      agentManager: ctx.runtime.agentManager,
      implementerTier: input.implementerTier ?? "balanced",
      lite: input.lite ?? false,
      testSummary,
      testCmd: gateCtx.testCmd,
      fullSuiteTimeout: gateCtx.fullSuiteTimeout,
      testOutput,
      runtime: ctx.runtime,
      featureName: input.featureName,
      projectDir: input.projectDir,
      sessionManager: ctx.runtime.sessionManager,
      scopeId: ctx.scopeId,
    });
    return { exhausted: result.exhausted, attempts: result.attempts, fixedAll: !result.exhausted };
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
    // Resolve config + test command once; both runTests and runRectificationLoop reuse.
    const gateCtx = await deps.resolveGateContext(input, ctx);

    // Step 1: Run tests (always — NEVER short-circuit based on rectification config)
    const testResult = await deps.runTests(input, gateCtx);

    // Step 2: Tests passed → done immediately
    if (testResult.passed) {
      return { success: true, passed: true, status: "passed", estimatedCostUsd: 0, attempts: 0 };
    }

    // Step 3: Tests failed, rectification disabled → fail without rectification
    // Critical fix: old code returned "disabled" BEFORE running tests, causing the
    // TDD verifier to be skipped even when tests actually passed.
    if (!input.rectificationEnabled) {
      return { success: false, passed: false, status: "failed-no-rectification", estimatedCostUsd: 0, attempts: 0 };
    }

    // Step 4: Tests failed, rectification enabled → run rectification loop
    const rectResult = await deps.runRectificationLoop(input, ctx, gateCtx, testResult.output);
    if (rectResult.exhausted) {
      return {
        success: false,
        passed: false,
        status: "rectification-exhausted",
        estimatedCostUsd: 0,
        attempts: rectResult.attempts,
      };
    }
    return { success: true, passed: true, status: "passed", estimatedCostUsd: 0, attempts: rectResult.attempts };
  },
};
