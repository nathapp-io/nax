/**
 * Acceptance Retry Loop
 *
 * Handles the acceptance testing retry loop after main execution completes:
 * 1. Runs acceptance validation
 * 2. Detects test-level failures (>80% fail or crash) and regenerates test (P1-D)
 * 3. Generates batched fix stories for implementation-level failures
 * 4. Executes fix stories through pipeline
 * 5. Retries until max retries or all tests pass
 */

import { loadAcceptanceTestContent as loadAcceptanceTestContentModule } from "../../acceptance/content-loader";
import { loadSemanticVerdicts } from "../../acceptance/semantic-verdict";
import { findExistingAcceptanceTestPath as findExistingAcceptanceTestPathFromOptions } from "../../acceptance/test-path";
import type { DiagnosisResult } from "../../acceptance/types";
import type { NaxConfig } from "../../config";
import type { Finding } from "../../findings";
import { acFailureToFinding, acSentinelToFinding, runFixCycle } from "../../findings";
import type { FixCycle, FixCycleContext, FixCycleResult } from "../../findings";
import { type LoadedHooksConfig, fireHook } from "../../hooks";
import { getSafeLogger } from "../../logger";
import type { StoryMetrics } from "../../metrics";
import { acceptanceFixSourceOp, acceptanceFixTestOp } from "../../operations";
import type { PipelineEventEmitter } from "../../pipeline/events";
import type { AgentGetFn, PipelineContext } from "../../pipeline/types";
import type { PluginRegistry } from "../../plugins";
import type { PRD } from "../../prd/types";

import type { DispatchContext } from "../../runtime/dispatch-context";
import type { NaxIgnoreIndex } from "../../utils/path-filters";
import { hookCtx } from "../helpers";
import type { StatusWriter } from "../status-writer";
import { resolveAcceptanceDiagnosis } from "./acceptance-fix";
import {
  buildResult,
  isStubTestFile,
  regenerateAcceptanceTest as regenerateAcceptanceTestFn,
} from "./acceptance-helpers";

export {
  buildResult,
  isStubTestFile,
  isTestLevelFailure,
  loadAcceptanceTestContent,
  loadSpecContent,
  regenerateAcceptanceTest,
  _regenerateDeps,
} from "./acceptance-helpers";

export interface AcceptanceLoopContext extends DispatchContext {
  config: NaxConfig;
  prd: PRD;
  prdPath: string;
  workdir: string;
  featureDir?: string;
  hooks: LoadedHooksConfig;
  feature: string;
  totalCost: number;
  iterations: number;
  storiesCompleted: number;
  allStoryMetrics: StoryMetrics[];
  pluginRegistry: PluginRegistry;
  eventEmitter?: PipelineEventEmitter;
  statusWriter: StatusWriter;
  /** Protocol-aware agent resolver — passed from registry at run start */
  agentGetFn?: AgentGetFn;
  /** Pre-resolved .naxignore matcher cache shared across run stages */
  naxIgnoreIndex?: NaxIgnoreIndex;
  /** Per-package acceptance test paths — used to load test content for fix routing */
  acceptanceTestPaths?: Array<{ testPath: string; packageDir: string }>;
}

export interface AcceptanceLoopResult {
  success: boolean;
  prd: PRD;
  totalCost: number;
  iterations: number;
  storiesCompleted: number;
  prdDirty: boolean;
  /** Acceptance criteria that failed — populated when success=false */
  failedACs?: string[];
  /** Number of acceptance retries performed */
  retries?: number;
}

// isStubTestFile, isTestLevelFailure, loadSpecContent, loadAcceptanceTestContent,
// buildResult — extracted to acceptance-helpers.ts (re-exported above)

export const _acceptanceLoopDeps = {
  loadSemanticVerdicts,
};

/** Injectable deps for the fix cycle — swap in tests. */
export const _acceptanceFixCycleDeps = {
  runFixCycle,
};

// _regenerateDeps, regenerateAcceptanceTest, generateAndAddFixStories, executeFixStory
// — extracted to acceptance-helpers.ts or deleted (dead code)

const MAX_STUB_REGENS = 2;

// ─── acceptance fix cycle helpers ────────────────────────────────────────────

interface AcceptanceTestRunResult {
  passed: boolean;
  failedACs: string[];
  testOutput: string;
}

function convertFailuresToFindings(failedACs: string[], testOutput: string): Finding[] {
  return failedACs.map((ac) => {
    if (ac === "AC-HOOK" || ac === "AC-ERROR") {
      return acSentinelToFinding(ac as "AC-HOOK" | "AC-ERROR", testOutput);
    }
    return acFailureToFinding(ac, testOutput);
  });
}

function buildFixCycleCtx(
  ctx: AcceptanceLoopContext,
  runtime: NonNullable<AcceptanceLoopContext["runtime"]>,
  storyId: string,
): FixCycleContext {
  return {
    runtime,
    packageView: runtime.packages.resolve(ctx.workdir),
    packageDir: ctx.workdir,
    storyId,
    featureName: ctx.feature,
    // agentName captured once at cycle construction time; fallback changes not reflected mid-cycle
    agentName: ctx.agentManager?.getDefault() ?? "claude",
  };
}

function buildAcceptanceContext(ctx: AcceptanceLoopContext, prd: PRD): PipelineContext {
  const firstStory = prd.userStories[0];
  return {
    config: ctx.config,
    rootConfig: ctx.config,
    prd,
    story: firstStory,
    stories: [firstStory],
    routing: {
      complexity: "simple",
      modelTier: "balanced",
      testStrategy: "test-after",
      reasoning: "Acceptance validation",
    },
    projectDir: ctx.workdir,
    workdir: ctx.workdir,
    naxIgnoreIndex: ctx.naxIgnoreIndex,
    featureDir: ctx.featureDir,
    hooks: ctx.hooks,
    plugins: ctx.pluginRegistry,
    agentGetFn: ctx.agentGetFn,
    agentManager: ctx.agentManager,
    sessionManager: ctx.sessionManager,
    acceptanceTestPaths: ctx.acceptanceTestPaths,
    runtime: ctx.runtime,
    abortSignal: ctx.abortSignal,
  };
}

async function runAcceptanceTestsOnce(ctx: AcceptanceLoopContext, prd: PRD): Promise<AcceptanceTestRunResult> {
  const acceptanceContext = buildAcceptanceContext(ctx, prd);
  const { acceptanceStage } = await import("../../pipeline/stages/acceptance");
  const result = await acceptanceStage.execute(acceptanceContext);
  if (result.action !== "fail") return { passed: true, failedACs: [], testOutput: "" };
  const failures = acceptanceContext.acceptanceFailures;
  if (!failures || failures.failedACs.length === 0) return { passed: true, failedACs: [], testOutput: "" };
  return { passed: false, failedACs: failures.failedACs, testOutput: failures.testOutput };
}

/**
 * Run the acceptance fix cycle using runFixCycle (ADR-022 phase 4).
 *
 * Two co-run-sequential strategies:
 *   - acceptance-source-fix: appliesTo fixTarget==="source", appliesToVerdict source_bug/both
 *   - acceptance-test-fix:   appliesTo fixTarget==="test",   appliesToVerdict test_bug/both
 *
 * Validate fn re-runs acceptance tests and converts failures to Finding[].
 * buildPriorIterationsBlock(priorIterations) replaced the hand-rolled previousFailure
 * string accumulator. Note: only acceptance-test-fix uses priorIterations — the source-fix
 * op type does not accept it, so source-fix prompts intentionally omit prior-attempt context.
 */
export async function runAcceptanceFixCycle(
  ctx: AcceptanceLoopContext,
  prd: PRD,
  initialFailures: { failedACs: string[]; testOutput: string },
  diagnosis: DiagnosisResult,
  testFileContent: string,
  acceptanceTestPath: string,
): Promise<FixCycleResult<Finding>> {
  const runtime = ctx.runtime;
  if (!runtime) {
    return { iterations: [], finalFindings: [], exitReason: "no-strategy" };
  }

  let currentTestOutput = initialFailures.testOutput;
  let currentFailedACs = initialFailures.failedACs;

  const storyId = prd.userStories[0]?.id ?? "unknown";
  const cycleCtx = buildFixCycleCtx(ctx, runtime, storyId);

  const cycle: FixCycle<Finding> = {
    findings: convertFailuresToFindings(initialFailures.failedACs, initialFailures.testOutput),
    iterations: [],
    strategies: [
      {
        name: "acceptance-source-fix",
        appliesTo: (f) => f.fixTarget === "source",
        appliesToVerdict: (v) => v === "source_bug" || v === "both",
        fixOp: acceptanceFixSourceOp,
        buildInput: (_findings, _priorIterations, _ctx) => ({
          testOutput: currentTestOutput,
          diagnosisReasoning: diagnosis.reasoning,
          acceptanceTestPath,
          testFileContent,
        }),
        maxAttempts: 3,
        coRun: "co-run-sequential",
      },
      {
        name: "acceptance-test-fix",
        appliesTo: (f) => f.fixTarget === "test",
        appliesToVerdict: (v) => v === "test_bug" || v === "both",
        fixOp: acceptanceFixTestOp,
        buildInput: (_findings, _priorIterations, _ctx) => ({
          testOutput: currentTestOutput,
          diagnosisReasoning: diagnosis.reasoning,
          failedACs: currentFailedACs,
          acceptanceTestPath,
          testFileContent,
        }),
        maxAttempts: 3,
        coRun: "co-run-sequential",
      },
    ],
    validate: async (_ctx) => {
      const result = await runAcceptanceTestsOnce(ctx, prd);
      if (result.passed) return [];
      currentTestOutput = result.testOutput;
      currentFailedACs = result.failedACs;
      return convertFailuresToFindings(result.failedACs, result.testOutput);
    },
    config: {
      maxAttemptsTotal: ctx.config.acceptance.maxRetries,
      validatorRetries: 1,
    },
    verdict: diagnosis.verdict,
  };

  return _acceptanceFixCycleDeps.runFixCycle(cycle, cycleCtx, "acceptance");
}

/**
 * Run the acceptance retry loop.
 *
 * Each iteration:
 *   1. Run acceptance tests → PASS → done / FAIL → collect failures
 *   2. Stub guard (with stubRegenCount cap) → regen + continue
 *   3. Diagnose (fresh each iteration via resolveAcceptanceDiagnosis)
 *   4. runAcceptanceFixCycle(diagnosis) — runFixCycle handles retries
 *   5. return result (runFixCycle replaces all subsequent outer passes)
 *
 * The outer loop owns stub guard and diagnosis. runFixCycle owns fix retry logic.
 */
export async function runAcceptanceLoop(ctx: AcceptanceLoopContext): Promise<AcceptanceLoopResult> {
  const logger = getSafeLogger();
  const maxRetries = ctx.config.acceptance.maxRetries;

  let acceptanceRetries = 0;
  let stubRegenCount = 0;
  const prd = ctx.prd;
  const totalCost = ctx.totalCost;
  const iterations = ctx.iterations;
  const storiesCompleted = ctx.storiesCompleted;
  const prdDirty = false;

  logger?.info("acceptance", "All stories complete, running acceptance validation");

  const { acceptanceStage } = await import("../../pipeline/stages/acceptance");

  while (acceptanceRetries < maxRetries) {
    // ── 1. Run acceptance ────────────────────────────────────────────────
    const firstStory = prd.userStories[0];
    const acceptanceContext = buildAcceptanceContext(ctx, prd);
    const acceptanceResult = await acceptanceStage.execute(acceptanceContext);

    if (acceptanceResult.action === "continue") {
      logger?.info("acceptance", "Acceptance validation passed!");
      return buildResult(true, prd, totalCost, iterations, storiesCompleted, prdDirty);
    }

    if (acceptanceResult.action !== "fail") {
      logger?.warn("acceptance", `Unexpected acceptance result: ${acceptanceResult.action}`);
      return buildResult(false, prd, totalCost, iterations, storiesCompleted, prdDirty);
    }

    const failures = acceptanceContext.acceptanceFailures;
    if (!failures || failures.failedACs.length === 0) {
      logger?.error("acceptance", "Acceptance tests failed but no specific failures detected");
      await fireHook(
        ctx.hooks,
        "on-pause",
        hookCtx(ctx.feature, { reason: "Acceptance tests failed (no failures detected)", cost: totalCost }),
        ctx.workdir,
      );
      return buildResult(false, prd, totalCost, iterations, storiesCompleted, prdDirty);
    }

    // ── 2. retries++ ─────────────────────────────────────────────────────
    acceptanceRetries++;
    logger?.warn("acceptance", `Acceptance retry ${acceptanceRetries}/${maxRetries}`, {
      storyId: firstStory?.id,
      failedACs: failures.failedACs,
    });

    if (acceptanceRetries >= maxRetries) {
      logger?.error("acceptance", "Max acceptance retries reached", { storyId: firstStory?.id });
      await fireHook(
        ctx.hooks,
        "on-pause",
        hookCtx(ctx.feature, {
          reason: `Acceptance validation failed after ${maxRetries} retries: ${failures.failedACs.join(", ")}`,
          cost: totalCost,
        }),
        ctx.workdir,
      );
      return buildResult(
        false,
        prd,
        totalCost,
        iterations,
        storiesCompleted,
        prdDirty,
        failures.failedACs,
        acceptanceRetries,
      );
    }

    // ── 3. Stub guard (stubRegenCount capped at 2) ───────────────────────
    if (ctx.featureDir) {
      const existingStubPath = await findExistingAcceptanceTestPathFromOptions({
        acceptanceTestPaths: ctx.acceptanceTestPaths,
        featureDir: ctx.featureDir,
        testPathConfig: ctx.config.acceptance.testPath,
        language: ctx.config.project?.language,
      });
      if (existingStubPath && isStubTestFile(await Bun.file(existingStubPath).text())) {
        if (stubRegenCount >= MAX_STUB_REGENS) {
          logger?.error("acceptance", "Acceptance test generator cannot produce real tests — giving up", {
            storyId: firstStory?.id,
            stubRegenCount,
          });
          return buildResult(
            false,
            prd,
            totalCost,
            iterations,
            storiesCompleted,
            prdDirty,
            failures.failedACs,
            acceptanceRetries,
          );
        }
        stubRegenCount++;
        logger?.warn("acceptance", "Stub test detected — full regen", {
          storyId: firstStory?.id,
          attempt: stubRegenCount,
          maxStubRegens: MAX_STUB_REGENS,
        });
        await regenerateAcceptanceTestFn(existingStubPath, acceptanceContext);
        continue; // back to acceptance test
      }
    }

    // ── 4. Diagnose (fresh each iteration) ───────────────────────────────
    const semanticVerdicts = ctx.featureDir ? await _acceptanceLoopDeps.loadSemanticVerdicts(ctx.featureDir) : [];
    const totalACs = prd.userStories
      .filter((s) => !s.id.startsWith("US-FIX-"))
      .flatMap((s) => s.acceptanceCriteria).length;

    if (!ctx.runtime) {
      logger?.error("acceptance", "Runtime not found for diagnosis", { storyId: firstStory?.id });
      return buildResult(
        false,
        prd,
        totalCost,
        iterations,
        storiesCompleted,
        prdDirty,
        failures.failedACs,
        acceptanceRetries,
      );
    }

    // Load test file content for diagnosis
    const testEntries = ctx.acceptanceTestPaths
      ? await loadAcceptanceTestContentModule(ctx.acceptanceTestPaths.map((p) => p.testPath))
      : [];
    const testFileContent = testEntries[0]?.content ?? "";
    const acceptanceTestPath = testEntries[0]?.testPath ?? ctx.acceptanceTestPaths?.[0]?.testPath ?? "";

    const strategy = ctx.config.acceptance.fix?.strategy ?? "diagnose-first";
    const diagnosis = await resolveAcceptanceDiagnosis({
      ctx,
      failures,
      totalACs,
      strategy,
      semanticVerdicts,
      diagnosisOpts: {
        testOutput: failures.testOutput,
        testFileContent,
        workdir: ctx.workdir,
        storyId: firstStory?.id,
      },
    });

    logger?.info("acceptance.diagnosis", "Diagnosis resolved", {
      storyId: firstStory?.id,
      verdict: diagnosis.verdict,
      confidence: diagnosis.confidence,
      attempt: acceptanceRetries,
    });

    // ── 5. Run acceptance fix cycle ────────────────────────────────────
    const cycleResult = await runAcceptanceFixCycle(ctx, prd, failures, diagnosis, testFileContent, acceptanceTestPath);
    // "resolved" is the canonical success exit; also treat empty finalFindings as success
    // in case the last validate pass cleared all findings before runFixCycle emitted "resolved".
    const success = cycleResult.exitReason === "resolved" || cycleResult.finalFindings.length === 0;
    // retries here counts: 1 outer pass (acceptanceRetries) + N internal strategy attempts.
    return buildResult(
      success,
      prd,
      totalCost,
      iterations,
      storiesCompleted,
      prdDirty,
      success ? undefined : cycleResult.finalFindings.map((f) => f.message),
      acceptanceRetries + cycleResult.iterations.length,
    );
  }

  return buildResult(false, prd, totalCost, iterations, storiesCompleted, prdDirty);
}
