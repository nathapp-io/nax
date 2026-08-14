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

import {
  type DiagnosisResult,
  findExistingAcceptanceTestPath as findExistingAcceptanceTestPathFromOptions,
  loadAcceptanceTestContent as loadAcceptanceTestContentModule,
  loadSemanticVerdicts,
} from "@/acceptance";
import type { NaxConfig } from "@/config";
import type { Finding } from "@/findings";
import { acFailureToFinding, acSentinelToFinding, runFixCycle } from "@/findings";
import type { FixCycle, FixCycleContext, FixCycleResult } from "@/findings";
import { type LoadedHooksConfig, fireHook } from "@/hooks";
import { getSafeLogger } from "@/logger";
import type { StoryMetrics } from "@/metrics";
import { acceptanceFixSourceOp, acceptanceFixTestOp } from "@/operations";
import type { PipelineEventEmitter } from "@/pipeline/events";
import type { AgentGetFn, PipelineContext } from "@/pipeline/types";
import type { PluginRegistry } from "@/plugins";
import type { PRD } from "@/prd/types";
import { buildPriorIterationsBlock } from "@/prompts";
import type { DispatchContext } from "@/runtime/dispatch-context";
import type { NaxIgnoreIndex } from "@/utils/path-filters";
import { hookCtx } from "../helpers";
import type { StatusWriter } from "../status-writer";
import { resolveAcceptanceDiagnosis } from "./acceptance-fix";
import {
  buildFailureResult,
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
  acceptanceTestPaths?: AcceptanceTestPathEntry[];
  /**
   * Retry attempts consumed before the current acceptance attempt (0 on the first).
   * Owned by `runAcceptanceLoop`, which stamps a per-attempt copy of this context so
   * the stage can report a true retry count on its verdict. Re-validations inside a
   * fix cycle belong to the enclosing attempt and carry its index unchanged.
   */
  acceptanceRetries?: number;
  skippedPackages?: string[];
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
  skippedPackages?: string[];
}

// isStubTestFile, isTestLevelFailure, loadSpecContent, loadAcceptanceTestContent,
// buildResult — extracted to acceptance-helpers.ts (re-exported above)

export const _acceptanceLoopDeps = {
  loadSemanticVerdicts,
  loadAcceptanceTestContent: loadAcceptanceTestContentModule,
};

/** Injectable deps for the fix cycle — swap in tests. */
export const _acceptanceFixCycleDeps = {
  runFixCycle,
};

/** Injectable deps for runAcceptanceTestsOnce — swap in tests to avoid mock.module(). */
export const _runAcceptanceTestsOnceDeps = {
  importAcceptanceStage: () => import("../../pipeline/stages/acceptance"),
};

// _regenerateDeps, regenerateAcceptanceTest, generateAndAddFixStories, executeFixStory
// — extracted to acceptance-helpers.ts or deleted (dead code)

const MAX_STUB_REGENS = 2;

// ─── acceptance fix cycle helpers ────────────────────────────────────────────

interface AcceptanceTestRunResult {
  passed: boolean;
  failedACs: string[];
  testOutput: string;
  failedPackages?: AcceptanceFailedPackage[];
  /**
   * Package dirs whose acceptance test target is missing (US-003). When present
   * the run must fail closed even though `failedACs` is empty — the missing
   * target is the failure, not a passing test.
   */
  missingTargets?: string[];
}

type AcceptanceTestPathEntry = NonNullable<PipelineContext["acceptanceTestPaths"]>[number];

type AcceptanceFailedPackage = NonNullable<
  NonNullable<PipelineContext["acceptanceFailures"]>["failedPackages"]
>[number];

export function resolveAcceptanceFixTarget(
  acceptanceTestPaths: AcceptanceTestPathEntry[] | undefined,
  failedPackage: { testPath: string; packageDir: string; commandOverride?: string } | undefined,
  config: NaxConfig,
): {
  acceptanceTestPath: string;
  testCommand: string | undefined;
} {
  const matchedEntry = failedPackage
    ? acceptanceTestPaths?.find(
        (entry) => entry.testPath === failedPackage.testPath || entry.packageDir === failedPackage.packageDir,
      )
    : undefined;
  const selectedPathEntry = matchedEntry ?? acceptanceTestPaths?.[0];
  return {
    acceptanceTestPath: failedPackage?.testPath ?? selectedPathEntry?.testPath ?? "",
    testCommand:
      failedPackage?.commandOverride ??
      matchedEntry?.commandOverride ??
      config.acceptance.command ??
      config.quality?.commands?.test,
  };
}

function convertFailuresToFindings(failedACs: string[], testOutput: string): Finding[] {
  return failedACs.map((ac) => {
    if (ac === "AC-HOOK" || ac === "AC-ERROR") {
      return acSentinelToFinding(ac as "AC-HOOK" | "AC-ERROR", testOutput);
    }
    return acFailureToFinding(ac, testOutput);
  });
}

function findingsForDiagnosis(failedACs: string[], testOutput: string, diagnosis: DiagnosisResult): Finding[] {
  if (diagnosis.findings && diagnosis.findings.length > 0) return diagnosis.findings;

  const findings = convertFailuresToFindings(failedACs, testOutput);
  const isTestRunnerSentinel = (f: Finding): boolean =>
    f.category === "hook-failure" || f.category === "test-runner-error";
  if (diagnosis.verdict === "source_bug") {
    return findings.map((f) => (isTestRunnerSentinel(f) ? f : { ...f, fixTarget: "source" }));
  }
  if (diagnosis.verdict === "test_bug") return findings.map((f) => ({ ...f, fixTarget: "test" }));
  return findings.flatMap((f) =>
    isTestRunnerSentinel(f)
      ? [f]
      : [
          { ...f, fixTarget: "source" as const },
          { ...f, fixTarget: "test" as const },
        ],
  );
}

function buildFixCycleCtx(
  ctx: AcceptanceLoopContext,
  runtime: NonNullable<AcceptanceLoopContext["runtime"]>,
  storyId: string,
  packageDir: string,
): FixCycleContext {
  return {
    runtime,
    packageView: runtime.packages.resolve(packageDir),
    packageDir,
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
    acceptanceRetries: ctx.acceptanceRetries ?? 0,
    runtime: ctx.runtime,
    abortSignal: ctx.abortSignal,
  };
}

async function runAcceptanceTestsOnce(
  ctx: AcceptanceLoopContext,
  prd: PRD,
  packageFilter?: AcceptanceTestPathEntry[],
): Promise<AcceptanceTestRunResult> {
  const baseCtx: AcceptanceLoopContext = packageFilter ? { ...ctx, acceptanceTestPaths: packageFilter } : ctx;
  const acceptanceContext = buildAcceptanceContext(baseCtx, prd);
  const { acceptanceStage } = await _runAcceptanceTestsOnceDeps.importAcceptanceStage();
  const result = await acceptanceStage.execute(acceptanceContext);
  if (result.action !== "fail") return { passed: true, failedACs: [], testOutput: "" };
  const failures = acceptanceContext.acceptanceFailures;
  // US-003: a stage-returned fail with no failedACs is a missing-target failure,
  // not a pass — propagate it as failed so the loop fails closed. Without this,
  // a missing acceptance target is silently treated as a successful validation.
  if (failures?.missingTargets && failures.missingTargets.length > 0) {
    return {
      passed: false,
      failedACs: [],
      testOutput: failures.testOutput,
      failedPackages: failures.failedPackages,
      missingTargets: failures.missingTargets,
    };
  }
  if (!failures || failures.failedACs.length === 0) return { passed: true, failedACs: [], testOutput: "" };
  return {
    passed: false,
    failedACs: failures.failedACs,
    testOutput: failures.testOutput,
    failedPackages: failures.failedPackages,
  };
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
  acceptanceTestPath: string,
  testCommand?: string,
  fixTarget?: { packageDir: string; testPath: string },
): Promise<FixCycleResult<Finding>> {
  const runtime = ctx.runtime;
  if (!runtime) {
    return { iterations: [], finalFindings: [], exitReason: "no-strategy" };
  }

  let currentTestOutput = initialFailures.testOutput;
  let currentFailedACs = initialFailures.failedACs;

  const storyId = prd.userStories[0]?.id ?? "unknown";
  const cycleCtx = buildFixCycleCtx(ctx, runtime, storyId, fixTarget?.packageDir ?? ctx.workdir);

  const cycle: FixCycle<Finding> = {
    findings: findingsForDiagnosis(initialFailures.failedACs, initialFailures.testOutput, diagnosis),
    iterations: [],
    strategies: [
      {
        name: "acceptance-source-fix",
        appliesTo: (f) => f.fixTarget === "source",
        appliesToVerdict: (v) => v === "source_bug" || v === "both",
        fixOp: acceptanceFixSourceOp,
        buildInput: (_findings, priorIterations, _ctx) => ({
          testOutput: currentTestOutput,
          testCommand,
          diagnosisReasoning: diagnosis.reasoning,
          priorIterationsBlock: buildPriorIterationsBlock(priorIterations),
          acceptanceTestPath,
        }),
        maxAttempts: 3,
        coRun: "co-run-sequential",
      },
      {
        name: "acceptance-test-fix",
        appliesTo: (f) => f.fixTarget === "test",
        appliesToVerdict: (v) => v === "test_bug" || v === "both",
        fixOp: acceptanceFixTestOp,
        buildInput: (_findings, priorIterations, _ctx) => ({
          testOutput: currentTestOutput,
          testCommand,
          diagnosisReasoning: diagnosis.reasoning,
          priorIterationsBlock: buildPriorIterationsBlock(priorIterations),
          failedACs: currentFailedACs,
          acceptanceTestPath,
        }),
        maxAttempts: 3,
        coRun: "co-run-sequential",
      },
    ],
    validate: async (_ctx, _opts: { mode: "full" | "lite" }) => {
      const packageFilter = fixTarget
        ? ctx.acceptanceTestPaths?.filter((entry) => entry.packageDir === fixTarget.packageDir)
        : undefined;
      const result = await runAcceptanceTestsOnce(ctx, prd, packageFilter);
      if (result.passed) return [];
      currentTestOutput = result.testOutput;
      currentFailedACs = result.failedACs;
      return findingsForDiagnosis(result.failedACs, result.testOutput, diagnosis);
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
 * Each outer iteration:
 *   1. Run acceptance tests → PASS → done / FAIL → collect per-package failures
 *   2. Stub guard (with stubRegenCount cap) → regen + continue
 *   3. Per-package fan-out (#1277): for each failed package, diagnose over that
 *      package's sliced output and run a fix cycle scoped to its packageDir,
 *      testPath, and command. Budget is PER-PACKAGE — each failed package gets
 *      its own maxRetries via runFixCycle's maxAttemptsTotal.
 *   4. Final full validation pass (all packages) → success only if it passes
 *      and no package-level findings remain.
 *
 * The outer loop owns the stub guard and the package fan-out. runFixCycle owns
 * per-package fix retry logic.
 */
export async function runAcceptanceLoop(ctx: AcceptanceLoopContext): Promise<AcceptanceLoopResult> {
  const logger = getSafeLogger();
  const maxRetries = ctx.config.acceptance.maxRetries;

  let acceptanceRetries = 0;
  let stubRegenCount = 0;
  const prd = ctx.prd;
  let totalCost = ctx.totalCost;
  const iterations = ctx.iterations;
  const storiesCompleted = ctx.storiesCompleted;
  const prdDirty = false;

  logger?.info("acceptance", "All stories complete, running acceptance validation");

  const { acceptanceStage } = await _runAcceptanceTestsOnceDeps.importAcceptanceStage();

  do {
    // ── 1. Run acceptance ────────────────────────────────────────────────
    // Stamp the attempt index onto a per-iteration copy so the stage's verdict
    // reports a real retry count. Fix-cycle re-validations reuse this same copy
    // and so stay attributed to the attempt that triggered them.
    const attemptCtx: AcceptanceLoopContext = { ...ctx, acceptanceRetries };
    const firstStory = prd.userStories[0];
    const acceptanceContext = buildAcceptanceContext(attemptCtx, prd);
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
    const skippedPackages =
      (acceptanceResult as { skippedPackages?: string[] }).skippedPackages ?? failures?.missingTargets;
    if (!failures || failures.failedACs.length === 0) {
      logger?.error("acceptance", "Acceptance tests failed but no specific failures detected");
      await fireHook(
        ctx.hooks,
        "on-pause",
        hookCtx(ctx.feature, { reason: "Acceptance tests failed (no failures detected)", cost: totalCost }),
        ctx.workdir,
      );
      return buildFailureResult(prd, totalCost, iterations, storiesCompleted, undefined, undefined, skippedPackages);
    }

    // ── 2. retries++ ─────────────────────────────────────────────────────
    acceptanceRetries++;
    logger?.warn("acceptance", `Acceptance retry ${acceptanceRetries}/${maxRetries}`, {
      storyId: firstStory?.id,
      failedACs: failures.failedACs,
    });

    if (acceptanceRetries > maxRetries) {
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
      return buildFailureResult(
        prd,
        totalCost,
        iterations,
        storiesCompleted,
        failures.failedACs,
        acceptanceRetries,
        skippedPackages,
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
          return buildFailureResult(
            prd,
            totalCost,
            iterations,
            storiesCompleted,
            failures.failedACs,
            acceptanceRetries,
            skippedPackages,
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
      return buildFailureResult(
        prd,
        totalCost,
        iterations,
        storiesCompleted,
        failures.failedACs,
        acceptanceRetries,
        skippedPackages,
      );
    }

    // ── 4+5. Per-package fan-out: diagnose + fix each failed package ──────
    // #1277: one fix cycle per failed package, each scoped to its packageDir,
    // testPath, command, and sliced output. Budget is per-package (each gets
    // its own maxRetries). A final full validation pass catches cross-package
    // regressions before declaring success.
    const failedPkgs =
      failures.failedPackages && failures.failedPackages.length > 0
        ? failures.failedPackages
        : [{ testPath: "", packageDir: ctx.workdir, output: failures.testOutput, failedACs: failures.failedACs }];

    // NOTE: `semanticVerdicts` and `totalACs` are ALREADY declared above
    // (runtime-null guard scope) — DO NOT re-declare them here.
    const strategy = ctx.config.acceptance.fix?.strategy ?? "diagnose-first";

    const testEntries = ctx.acceptanceTestPaths
      ? await _acceptanceLoopDeps.loadAcceptanceTestContent(ctx.acceptanceTestPaths.map((p) => p.testPath))
      : [];

    const remainingFindings: Finding[] = [];
    let totalInternalIterations = 0;
    for (const pkg of failedPkgs) {
      const { acceptanceTestPath, testCommand } = resolveAcceptanceFixTarget(ctx.acceptanceTestPaths, pkg, ctx.config);
      const effectivePath = acceptanceTestPath || pkg.testPath || testEntries[0]?.testPath || "";
      const testFileContent = testEntries.find((entry) => entry.testPath === effectivePath)?.content ?? "";

      const pkgFailures = { failedACs: pkg.failedACs, testOutput: pkg.output };
      const diagnosis = await resolveAcceptanceDiagnosis({
        ctx,
        failures: pkgFailures,
        totalACs,
        strategy,
        semanticVerdicts,
        diagnosisOpts: {
          testOutput: pkg.output,
          testFileContent,
          acceptanceTestPath: effectivePath,
          workdir: pkg.packageDir,
          storyId: firstStory?.id,
        },
      });

      logger?.info("acceptance.diagnosis", "Diagnosis resolved", {
        storyId: firstStory?.id,
        packageDir: pkg.packageDir,
        verdict: diagnosis.verdict,
        confidence: diagnosis.confidence,
        attempt: acceptanceRetries,
      });

      const cycleResult = await runAcceptanceFixCycle(
        attemptCtx,
        prd,
        pkgFailures,
        diagnosis,
        effectivePath,
        testCommand,
        { packageDir: pkg.packageDir, testPath: effectivePath },
      );
      totalCost += cycleResult.costUsd ?? 0;
      totalInternalIterations += cycleResult.iterations.length;
      const pkgResolved = cycleResult.exitReason === "resolved" || cycleResult.finalFindings.length === 0;
      if (!pkgResolved) remainingFindings.push(...cycleResult.finalFindings);
    }

    // ── Final full validation pass (all packages) — catches cross-package
    //    regressions one isolated cycle could miss. ───────────────────────
    const finalCheck = await runAcceptanceTestsOnce(attemptCtx, prd);
    const success = finalCheck.passed && remainingFindings.length === 0;
    const failureMessages = !success
      ? finalCheck.failedACs.length > 0
        ? finalCheck.failedACs
        : remainingFindings.length > 0
          ? remainingFindings.map((f) => f.message)
          : ["acceptance validation failed (unknown cause)"]
      : undefined;
    return buildResult(
      success,
      prd,
      totalCost,
      iterations,
      storiesCompleted,
      prdDirty,
      failureMessages,
      acceptanceRetries + totalInternalIterations,
      finalCheck.missingTargets,
    );
  } while (acceptanceRetries <= maxRetries);

  return buildResult(false, prd, totalCost, iterations, storiesCompleted, prdDirty); // defensive fallback
}
