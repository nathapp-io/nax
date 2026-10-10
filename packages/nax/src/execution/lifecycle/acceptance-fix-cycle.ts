/** Acceptance fix cycle — moved from acceptance-loop.ts for file-size compliance. */
import type { DiagnosisResult } from "@/acceptance";
import type { FailedCriterion } from "@/acceptance/failed-criteria";
import type { Finding, FixCycle, FixCycleResult } from "@/findings";
import { acFailureToFinding, acSentinelToFinding, runFixCycle } from "@/findings";
import { acceptanceFixSourceOp, acceptanceFixTestOp } from "@/operations";
import type { PipelineContext } from "@/pipeline/types";
import type { PRD } from "@/prd/types";
import { buildPriorIterationsBlock } from "@/prompts";
import { openAcceptanceFixScope } from "./acceptance-fix-scope";
import type { AcceptanceLoopContext, AcceptanceTestPathEntry } from "./acceptance-loop";
import { attemptFileHooks } from "./acceptance-summary";

/** Injectable deps for the fix cycle — swap in tests. */
export const _acceptanceFixCycleDeps = {
  runFixCycle,
};

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

type AcceptanceFailedPackage = NonNullable<
  NonNullable<PipelineContext["acceptanceFailures"]>["failedPackages"]
>[number];

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

export function buildAcceptanceContext(ctx: AcceptanceLoopContext, prd: PRD): PipelineContext {
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

/** Injectable deps for runAcceptanceTestsOnce — swap in tests to avoid mock.module(). */
export const _runAcceptanceTestsOnceDeps = {
  importAcceptanceStage: () => import("@/pipeline/stages"),
};

export async function runAcceptanceTestsOnce(
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
  failedCriteria?: FailedCriterion[],
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
          failedCriteria,
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
