/** Acceptance validation, diagnosis, and per-package fix retry orchestration. */
import {
  type DiagnosisResult,
  findExistingAcceptanceTestPath as findExistingAcceptanceTestPathFromOptions,
  groupStoryIdsForPackage,
  loadAcceptanceTestContent as loadAcceptanceTestContentModule,
  loadRefinedCriteria,
  resolveFailedCriteria,
} from "@/acceptance";
import type { FailedCriterion } from "@/acceptance/failed-criteria";
import type { NaxConfig } from "@/config";
import type { Finding, FixCycle, FixCycleResult } from "@/findings";
import { acFailureToFinding, acSentinelToFinding, runFixCycle } from "@/findings";
import { fireHook, type LoadedHooksConfig } from "@/hooks";
import type { InteractionChain } from "@/interaction";
import { getSafeLogger } from "@/logger";
import type { StoryMetrics } from "@/metrics";
import { acceptanceFixSourceOp, acceptanceFixTestOp } from "@/operations";
import type { PipelineEventEmitter } from "@/pipeline/events";
import type { AgentGetFn, PipelineContext } from "@/pipeline/types";
import type { PluginRegistry } from "@/plugins";
import { isLegacyFixStory } from "@/prd";
import type { PRD } from "@/prd/types";
import { buildPriorIterationsBlock } from "@/prompts";
import type { DispatchContext } from "@/runtime/dispatch-context";
import type { NaxIgnoreIndex } from "@/utils/path-filters";
import { hookCtx } from "../helpers";
import type { StatusWriter } from "../status-writer";
import { resolveAcceptanceDiagnosis } from "./acceptance-fix";
import { openAcceptanceFixScope } from "./acceptance-fix-scope";
import {
  buildFailureResult,
  buildResult,
  isStubTestFile,
  regenerateAcceptanceTest as regenerateAcceptanceTestFn,
  resolveAcceptanceFixTarget,
} from "./acceptance-helpers";
import {
  attemptFileHooks,
  createAcceptanceSummaryAccumulator,
  emitAcceptanceSummary,
  recordDiagnosis,
  recordFixIterations,
} from "./acceptance-summary";

export {
  _regenerateDeps,
  buildResult,
  isStubTestFile,
  isTestLevelFailure,
  loadAcceptanceTestContent,
  loadSpecContent,
  regenerateAcceptanceTest,
  // resolveAcceptanceFixTarget lives in acceptance-helpers.ts (file-size compliance,
  // #1939) — re-exported here so its import path stays "./acceptance-loop".
  resolveAcceptanceFixTarget,
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
  /** The run's interaction chain — the human link of the fix ops' ask resolver (#2201). */
  interactionChain?: InteractionChain | null;
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
  loadAcceptanceTestContent: loadAcceptanceTestContentModule,
};

/** Injectable deps for the fix cycle — swap in tests. */
export const _acceptanceFixCycleDeps = {
  runFixCycle,
};

/** Injectable deps for runAcceptanceTestsOnce — swap in tests to avoid mock.module(). */
export const _runAcceptanceTestsOnceDeps = {
  importAcceptanceStage: () => import("@/pipeline/stages"),
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

/** Exported for acceptance-helpers.ts's `resolveAcceptanceFixTarget` (file-size compliance). */
export type AcceptanceTestPathEntry = NonNullable<PipelineContext["acceptanceTestPaths"]>[number];

type AcceptanceFailedPackage = NonNullable<
  NonNullable<PipelineContext["acceptanceFailures"]>["failedPackages"]
>[number];

// resolveAcceptanceFixTarget — moved to acceptance-helpers.ts (file-size compliance,
// #1939) and re-exported above so its import path is unchanged.

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

/** Run the acceptance fix cycle with source-fix and test-fix strategies. */
export async function runAcceptanceFixCycle(
  ctx: AcceptanceLoopContext,
  prd: PRD,
  initialFailures: { failedACs: string[]; testOutput: string },
  diagnosis: DiagnosisResult,
  acceptanceTestPath: string,
  testCommand?: string,
  fixTarget?: { packageDir: string; testPath: string },
  /** Declared `quality.commands.testScoped` key, set only when the fix prompt can safely name it (#1939). */
  scopedCommandName?: string,
  _failedCriteria?: FailedCriterion[],
): Promise<FixCycleResult<Finding>> {
  const runtime = ctx.runtime;
  if (!runtime) {
    return { iterations: [], finalFindings: [], exitReason: "no-strategy" };
  }

  let currentTestOutput = initialFailures.testOutput;
  let currentFailedACs = initialFailures.failedACs;

  const storyId = prd.userStories[0]?.id ?? "unknown";
  const sourceAttempt = attemptFileHooks(fixTarget?.packageDir ?? ctx.workdir);
  const testAttempt = attemptFileHooks(fixTarget?.packageDir ?? ctx.workdir);

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
          scopedCommandName,
          failedCriteria: _failedCriteria,
        }),
        beforeDispatch: sourceAttempt.beforeDispatch,
        extractApplied: async (output) => ({
          targetFiles: await sourceAttempt.changedFiles(),
          unresolved: output.unresolved,
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
          scopedCommandName,
        }),
        beforeDispatch: testAttempt.beforeDispatch,
        extractApplied: async () => ({ targetFiles: await testAttempt.changedFiles() }),
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

  // #2201: the scope carries the ask resolver + command shadow the Bash-declaring
  // fix ops need, and owns their lifetime — disposed once the cycle settles.
  const scope = await openAcceptanceFixScope(ctx, runtime, storyId, fixTarget?.packageDir ?? ctx.workdir);
  try {
    return await _acceptanceFixCycleDeps.runFixCycle(cycle, scope.cycleCtx, "acceptance");
  } finally {
    await scope.dispose();
  }
}

/** Run per-package acceptance validation, diagnosis and fix cycles. */
async function runAcceptanceLoopWithSummary(ctx: AcceptanceLoopContext): Promise<AcceptanceLoopResult> {
  const accumulator = createAcceptanceSummaryAccumulator();
  let result: AcceptanceLoopResult | undefined;
  try {
    result = await acceptanceLoopImplementation.runAcceptanceLoop(ctx, accumulator);
    return result;
  } finally {
    emitAcceptanceSummary(accumulator, {
      prd: ctx.prd,
      outcome: result?.success ? "passed" : "failed",
      retries: result?.retries ?? 0,
      storyId: ctx.prd.userStories[0]?.id,
    });
  }
}

const acceptanceLoopImplementation = {
  async runAcceptanceLoop(
    ctx: AcceptanceLoopContext,
    accumulator: ReturnType<typeof createAcceptanceSummaryAccumulator>,
  ): Promise<AcceptanceLoopResult> {
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
      // `isLegacyFixStory`, not `isInAcceptanceScope` — see that module on why
      // this one total keeps counting decomposed parents.
      const totalACs = prd.userStories.filter((s) => !isLegacyFixStory(s)).flatMap((s) => s.acceptanceCriteria).length;

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

      const strategy = ctx.config.acceptance.fix?.strategy ?? "diagnose-first";

      const testEntries = ctx.acceptanceTestPaths
        ? await _acceptanceLoopDeps.loadAcceptanceTestContent(ctx.acceptanceTestPaths.map((p) => p.testPath))
        : [];

      const refinedCriteria = await loadRefinedCriteria(ctx.featureDir);
      const remainingFindings: Finding[] = [];
      let totalInternalIterations = 0;
      for (const pkg of failedPkgs) {
        const packageView = ctx.runtime.packages.resolve(pkg.packageDir);
        const packageConfig = packageView.hasOverride ? packageView.config : ctx.config;
        const { acceptanceTestPath, testCommand, scopedCommandName } = resolveAcceptanceFixTarget(
          ctx.acceptanceTestPaths,
          pkg,
          packageConfig,
        );
        const effectivePath = acceptanceTestPath || pkg.testPath || testEntries[0]?.testPath || "";
        const testFileContent = testEntries.find((entry) => entry.testPath === effectivePath)?.content ?? "";

        const pkgFailures = { failedACs: pkg.failedACs, testOutput: pkg.output };
        const failedCriteria = resolveFailedCriteria({
          refined: refinedCriteria,
          groupStoryIds: groupStoryIdsForPackage(prd, ctx.workdir, pkg.packageDir),
          failedACs: pkg.failedACs,
        });
        const diagnosis = await resolveAcceptanceDiagnosis({
          ctx,
          failures: pkgFailures,
          totalACs,
          strategy,
          diagnosisOpts: {
            testOutput: pkg.output,
            testFileContent,
            acceptanceTestPath: effectivePath,
            workdir: pkg.packageDir,
            config: packageConfig,
            storyId: firstStory?.id,
            failedCriteria,
          },
        });

        recordDiagnosis(accumulator, diagnosis);
        logger?.info("acceptance.diagnosis", "Diagnosis resolved", {
          storyId: firstStory?.id,
          packageDir: pkg.packageDir,
          verdict: diagnosis.verdict,
          confidence: diagnosis.confidence,
          path: diagnosis.path,
          failedACs: pkg.failedACs,
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
          scopedCommandName,
          failedCriteria,
        );
        recordFixIterations(accumulator, cycleResult.iterations);
        totalCost += cycleResult.costUsd ?? 0;
        totalInternalIterations += cycleResult.iterations.length;
        const pkgResolved = cycleResult.exitReason === "resolved" || cycleResult.finalFindings.length === 0;
        if (!pkgResolved) remainingFindings.push(...cycleResult.finalFindings);
      }

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
  },
};

export const runAcceptanceLoop = runAcceptanceLoopWithSummary;
