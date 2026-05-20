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

import type { ModelTier } from "../config";
import { rectificationGateConfigSelector } from "../config/selectors";
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
}

/**
 * Output from the full-suite gate.
 * Includes status classification and optional rectification attempts.
 * `passed` field is preserved for backward compat with post-run.ts → ctx.fullSuiteGatePassed.
 */
export interface FullSuiteGateOutput {
  readonly success: boolean; // true when passed; false on any failure
  readonly passed: boolean; // true only when tests actually passed
  readonly status: FullSuiteGateStatus;
  readonly cost: number;
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

export interface FullSuiteGateDeps {
  runTests: (input: FullSuiteGateInput, ctx: CallContext) => Promise<RunTestsResult>;
  runRectificationLoop: (
    input: FullSuiteGateInput,
    ctx: CallContext,
    testOutput: string,
  ) => Promise<RunRectificationResult>;
}

export const _fullSuiteGateDeps: FullSuiteGateDeps = {
  runTests: async (input, ctx) => {
    const { executeWithTimeout, parseTestOutput } = await import("../verification");
    const { resolveQualityTestCommands } = await import("../quality/command-resolver");
    const config = ctx.runtime.configLoader.current();
    const rectificationConfig = config.execution?.rectification;
    const fullSuiteTimeout = rectificationConfig?.fullSuiteTimeoutSeconds ?? 60;
    const { testCommand: resolvedTestCmd } = await resolveQualityTestCommands(
      config,
      input.workdir,
      input.story.workdir,
    );
    const effectiveTestCmd = resolvedTestCmd ?? "bun test";
    const result = await executeWithTimeout(effectiveTestCmd, fullSuiteTimeout, undefined, { cwd: input.workdir });
    const parsed = parseTestOutput(result.output ?? "");
    return {
      passed: result.success && result.exitCode === 0,
      failed: parsed.failed ?? 0,
      output: result.output ?? "",
    };
  },
  runRectificationLoop: async (input, ctx, testOutput) => {
    const { parseTestOutput } = await import("../verification");
    const { resolveQualityTestCommands } = await import("../quality/command-resolver");
    const config = ctx.runtime.configLoader.current();
    const rectificationConfig = config.execution?.rectification;
    const fullSuiteTimeout = rectificationConfig?.fullSuiteTimeoutSeconds ?? 60;
    const { testCommand: resolvedTestCmd } = await resolveQualityTestCommands(
      config,
      input.workdir,
      input.story.workdir,
    );
    const testCmd = resolvedTestCmd ?? "bun test";
    const testSummary = parseTestOutput(testOutput);
    const result = await runRectificationLoop({
      story: input.story,
      config,
      workdir: input.workdir,
      agentManager: ctx.runtime.agentManager,
      implementerTier: input.implementerTier ?? "balanced",
      lite: input.lite ?? false,
      testSummary,
      testCmd,
      fullSuiteTimeout,
      testOutput,
      runtime: ctx.runtime,
      featureName: input.featureName,
      projectDir: input.projectDir,
      sessionManager: ctx.runtime.sessionManager,
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
  stage: "run",
  config: fullSuiteGateConfigSelector,
  async execute(
    input: FullSuiteGateInput,
    ctx: CallContext,
    deps: FullSuiteGateDeps = _fullSuiteGateDeps,
  ): Promise<FullSuiteGateOutput> {
    // Step 1: Run tests (always — NEVER short-circuit based on rectification config)
    const testResult = await deps.runTests(input, ctx);

    // Step 2: Tests passed → done immediately
    if (testResult.passed) {
      return { success: true, passed: true, status: "passed", cost: 0, attempts: 0 };
    }

    // Step 3: Tests failed, rectification disabled → fail without rectification
    // Critical fix: old code returned "disabled" BEFORE running tests, causing the
    // TDD verifier to be skipped even when tests actually passed.
    if (!input.rectificationEnabled) {
      return { success: false, passed: false, status: "failed-no-rectification", cost: 0, attempts: 0 };
    }

    // Step 4: Tests failed, rectification enabled → run rectification loop
    const rectResult = await deps.runRectificationLoop(input, ctx, testResult.output);
    if (rectResult.exhausted) {
      return {
        success: false,
        passed: false,
        status: "rectification-exhausted",
        cost: 0,
        attempts: rectResult.attempts,
      };
    }
    return { success: true, passed: true, status: "passed", cost: 0, attempts: rectResult.attempts };
  },
};
