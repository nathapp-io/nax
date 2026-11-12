/**
 * Runner Completion Phase
 *
 * Handles post-execution steps: hooks, metrics, finish and cleanup.
 * Extracted from runner.ts for better code organization.
 */

import { loadConfigForPackage, type NaxConfig } from "@/config";
import type { LoadedHooksConfig } from "@/hooks";
import { fireHook } from "@/hooks";
import type { InteractionChain } from "@/interaction";
import { getSafeLogger } from "@/logger";
import type { StoryMetrics } from "@/metrics";
import { pipelineEventBus } from "@/pipeline/event-bus";
import type { PipelineEventEmitter } from "@/pipeline/events";
import type { AgentGetFn } from "@/pipeline/types";
import type { PluginRegistry } from "@/plugins/registry";
import type { PRD } from "@/prd";
import { isComplete } from "@/prd";
import { totalSpendUsd } from "@/runtime";
import type { DispatchContext } from "@/runtime/dispatch-context";
import { autoCommitIfDirty } from "@/utils/git";
import type { WorkflowFeatureInput, WorkflowFeatureResult } from "@/workflow";
import { repairRunState } from "../runstate";
import { recordAdvisorSummary } from "./advisor-summary";
import { reportAuthRelogins } from "./auth-relogin-report";
import { stopHeartbeat, writeExitSummary } from "./crash-recovery";
import type { DeferredReviewResult } from "./deferred-review";
import type { ExitReason } from "./executor-types";
import type { RunCompletionOptions, RunCompletionResult } from "./lifecycle/run-completion";
import { writeFinalFeatureStatus } from "./lifecycle/run-completion-phases";
import { workflowFinalRunStatus } from "./lifecycle/workflow-run-status";
import { hookCtx } from "./story-context";
import { createRunCompleteGate, runEndPhaseReported } from "./workflow-end-report";

/**
 * Options for the completion phase.
 */
export interface RunnerCompletionOptions extends DispatchContext {
  config: NaxConfig;
  hooks: LoadedHooksConfig;
  feature: string;
  workdir: string;
  statusFile: string;
  logFilePath?: string;
  runId: string;
  startedAt: string;
  startTime: number;
  formatterMode: "quiet" | "normal" | "verbose" | "json";
  headless: boolean;
  featureDir?: string;
  prd: PRD;
  allStoryMetrics: StoryMetrics[];
  totalCost: number;
  storiesCompleted: number;
  storiesGateOpen?: number;
  iterations: number;
  // biome-ignore lint/suspicious/noExplicitAny: StatusWriter interface varies by platform
  statusWriter: any;
  pluginRegistry: PluginRegistry;
  eventEmitter?: PipelineEventEmitter;
  /** Protocol-aware agent resolver */
  agentGetFn?: AgentGetFn;
  /** Path to prd.json — forwarded by the runner; no completion-phase step reads it. */
  prdPath: string;
  /**
   * Max parallel sessions, straight from RunnerOptions: undefined, 0 and 1 all
   * run one story at a time (the CLI rejects 0 outright), N > 1 caps at N.
   */
  parallel?: number;
  /** Per-run plugin-provider cache (Finding 5 / issue #473). Disposed in handleRunCompletion. */
  pluginProviderCache?: import("../context/engine").PluginProviderCache;
  /** End-of-run deferred plugin review result (#1146 G2). Forwarded to handleRunCompletion. */
  deferredReview?: DeferredReviewResult;
  /** Date.now() captured before postrun:phase:started for review was emitted. Forwarded to handleRunCompletion for accurate durationMs (AC9). */
  deferredReviewStartedAt?: number;
  /** Why the execution phase stopped — used to distinguish a cost-limit stop from a normal completion. */
  exitReason?: ExitReason;
  /** #2819 (`nax run --publish-only`): the feature workflow reruns only its publish step. */
  publishOnly?: boolean;
  /**
   * The run's interaction chain (alive until cleanupRun destroys it, after this
   * phase). Threaded to every post-run Bash-dispatching site — deferred
   * regression, finish, the feature workflow — as the human link of its ask
   * resolver (#2201).
   */
  interactionChain?: InteractionChain | null;
}

/**
 * Result from the completion phase.
 */
export interface RunnerCompletionResult {
  durationMs: number;
  runCompletedAt: string;
  /** True when a gating-mode deferred plugin reviewer failed. Factored into RunResult.success. */
  pluginGateFailed: boolean;
  /** Cost-aggregator-reconciled total for the whole run (successful plus failed-dispatch spend).
   *  Carried out of the completion phase so the returned RunResult.totalCost, the post-run
   *  context and reporter.onRunEnd all report the figure status.json already does. */
  reportedTotal: number;
  /** A5: false when the feature workflow did not pass (spec §7 "Run result"); absent in pipeline mode. */
  workflowPassed?: boolean;
}

/**
 * Injectable dependencies for testing (avoids mock.module() which leaks in Bun 1.x).
 * @internal - test use only.
 */
export const _runnerCompletionDeps: {
  handleRunCompletion(opts: RunCompletionOptions): Promise<RunCompletionResult>;
  // `from` is required, so this call site cannot drop the run's --profile chain
  // the way acceptance-setup's did (nax#2126).
  loadConfigForPackage(projectDir: string, packageDir: string | undefined, from: NaxConfig): Promise<NaxConfig>;
  runWorkflowFeature(input: WorkflowFeatureInput): Promise<WorkflowFeatureResult | null>;
  /** The run clock (wall ms); a seam so the workflow-duration split is testable. */
  now(): number;
} = {
  async handleRunCompletion(opts) {
    const { handleRunCompletion } = await import("./lifecycle/run-completion");
    return handleRunCompletion(opts);
  },
  loadConfigForPackage,
  async runWorkflowFeature(input) {
    const { runWorkflowFeature } = await import("@/workflow");
    return runWorkflowFeature(input);
  },
  now: () => Date.now(),
};

/**
 * Execute the completion phase of the run.
 *
 * @param options - Completion options
 * @returns Completion result
 */
export async function runCompletionPhase(options: RunnerCompletionOptions): Promise<RunnerCompletionResult> {
  const logger = getSafeLogger();

  logger?.debug("execution", "Completion phase started", {
    isComplete: isComplete(options.prd),
  });

  // Fire on-all-stories-complete before regression gate (RL-001)
  if (isComplete(options.prd)) {
    await fireHook(
      options.hooks,
      "on-all-stories-complete",
      hookCtx(options.feature, { status: "passed", cost: options.totalCost }),
      options.workdir,
    );
  }

  // Handle run completion: save metrics, log summary, update status
  const completionResult = await _runnerCompletionDeps.handleRunCompletion({
    runId: options.runId,
    feature: options.feature,
    startedAt: options.startedAt,
    prd: options.prd,
    allStoryMetrics: options.allStoryMetrics,
    totalCost: options.totalCost,
    storiesCompleted: options.storiesCompleted,
    storiesGateOpen: options.storiesGateOpen ?? 0,
    iterations: options.iterations,
    startTime: options.startTime,
    workdir: options.workdir,
    statusWriter: options.statusWriter,
    config: options.config,
    agentManager: options.agentManager,
    sessionManager: options.sessionManager,
    pluginProviderCache: options.pluginProviderCache,
    deferredReview: options.deferredReview,
    deferredReviewStartedAt: options.deferredReviewStartedAt,
    exitReason: options.exitReason,
    runtime: options.runtime,
    abortSignal: options.abortSignal,
    isSequential: true,
    interactionChain: options.interactionChain,
    // run.complete and run:completed follow the end phase (finish / feature workflow), when the whole duration is known (nax#2491, nax#2494).
    deferRunCompleteLog: true,
    deferRunCompletedEvent: true,
  });

  const { runCompletedAt, finalCounts, reportedTotal, pluginGateFailed } = completionResult;
  let durationMs = completionResult.durationMs;

  const { advisoryFindings, endReport } = await finishRun(options, completionResult, logger);
  const authRelogins = reportAuthRelogins(options.agentManager, logger);
  const { workflowPassed } = endReport;
  durationMs = endReport.durationMs;

  // Finish mutates postRun in memory and can add successful or failed-dispatch
  // spend. Persist both status paths and return the same reconciled total.
  // A1: advisor counts ride the same status write as finish (no-op when the advisor is off).
  await recordAdvisorSummary({
    config: options.config,
    statusWriter: options.statusWriter,
    repoRoot: options.workdir,
    feature: options.feature,
    outputDir: options.runtime?.outputDir,
  });
  const finalTotal = await persistFinishStatus(options, reportedTotal, completionResult.mcpAdoption);

  // Output run footer in headless mode
  if (options.headless && options.formatterMode !== "json") {
    const { outputAdvisoryFindingsSummary, outputRunFooter } = await import("./lifecycle/headless-formatter");
    outputAdvisoryFindingsSummary(advisoryFindings, options.formatterMode);
    outputRunFooter({
      finalCounts: {
        total: finalCounts.total,
        passed: finalCounts.passed,
        failed: finalCounts.failed,
        skipped: finalCounts.skipped,
      },
      durationMs,
      totalCost: finalTotal,
      startedAt: options.startedAt,
      completedAt: runCompletedAt,
      formatterMode: options.formatterMode,
      ...endReport.footer,
      authRelogins,
    });
  }

  // Write exit summary with finish spend included (US-007)
  logger?.debug("execution", "Completion phase — writing exit summary");
  await writeExitSummary(options.logFilePath, finalTotal, options.iterations, options.storiesCompleted, durationMs);

  // Close the NaxRuntime — flushes auditors, drains cost aggregator, aborts signal
  await options.runtime?.close();

  logger?.debug("execution", "Completion phase done — returning to runner");

  return {
    durationMs,
    runCompletedAt,
    pluginGateFailed,
    reportedTotal: finalTotal,
    ...(workflowPassed !== undefined ? { workflowPassed } : {}),
  };
}

/** Persist finish's in-memory outcome and reconcile the run's final spend. */
async function persistFinishStatus(
  options: RunnerCompletionOptions,
  reportedTotal: number,
  mcpAdoption: RunCompletionResult["mcpAdoption"],
): Promise<number> {
  const finalTotal = options.runtime ? totalSpendUsd(options.runtime.costAggregator.snapshot()) : reportedTotal;
  await options.statusWriter.update(finalTotal, options.iterations);
  if (options.featureDir) {
    await options.statusWriter.writeFeatureStatus(options.featureDir, finalTotal, options.iterations, {
      // nax#2410 D6: the adoption block survives the finish reconcile too.
      ...(mcpAdoption !== undefined ? { mcpAdoption } : {}),
    });
  }
  return finalTotal;
}

/**
 * Everything between handleRunCompletion and the run footer: final feature status, the advisory
 * warnings, the dirty-file auto-commit and the end phase. `run.complete` is held back by
 * handleRunCompletion in both modes; the gate guarantees it is written exactly once, with the timing so far,
 * even if something in here rejects before the end phase is closed (nax#2491, nax#2494).
 */
async function finishRun(
  options: RunnerCompletionOptions,
  completionResult: RunCompletionResult,
  logger: ReturnType<typeof getSafeLogger>,
) {
  const gate = createRunCompleteGate((final) => {
    completionResult.logRunComplete?.(final);
    completionResult.emitRunCompleted?.(final);
  });
  try {
    // Write feature-level status (SFC-002).
    // Use reportedTotal (cost-aggregator-corrected) instead of the legacy
    // options.totalCost accumulator, which drops acceptance/review/diagnosis
    // spend (issue #909).
    if (options.featureDir) {
      await writeFinalFeatureStatus({
        featureDir: options.featureDir,
        statusWriter: options.statusWriter,
        pluginGateFailed: completionResult.pluginGateFailed,
        exitReason: options.exitReason,
        prd: options.prd,
        reportedTotal: completionResult.reportedTotal,
        iterations: options.iterations,
        mcpAdoption: completionResult.mcpAdoption,
      });
    }

    // §2.1 — surface non-blocking (sub-threshold) review findings accumulated this run.
    // Without this, real findings below `blockingThreshold` are only visible in a
    // per-story debug log line and the on-disk `.nax/review-audit/` trail.
    const advisoryFindings = options.runtime?.reviewAuditor?.getAdvisoryFindings() ?? [];
    if (advisoryFindings.length > 0) {
      const coverageGapCount = advisoryFindings.filter((f) => f.coverageGap).length;
      logger?.warn("review", `${advisoryFindings.length} non-blocking review finding(s) surfaced at run end`, {
        storyId: "_run",
        count: advisoryFindings.length,
        coverageGapCount,
        findings: advisoryFindings,
      });
    }

    // Stop heartbeat before finish so stale execution totals cannot overwrite
    // the final status snapshot.
    stopHeartbeat();

    // #2490/#2497: repair any run state an agent reverted, deleted or hid,
    // so the auto-commit below sees it and the flag does not outlive the run.
    await repairRunState({ trigger: "run-end", workdir: options.workdir });

    // Commit status.json and any other nax runtime files left dirty at run end
    logger?.debug("execution", "Completion phase — auto-committing dirty files");
    await autoCommitIfDirty(options.workdir, "run.complete", "run-summary", options.feature, options.runtime?.dryRun);

    // Native finish phase (design 4.1). Must precede runtime.close(), whose own
    // comment below says it drains the cost aggregator and aborts the signal —
    // after it, finish's spend never reaches totalCost and its deadline signal
    // is already fired. Fail-open: a finish that cannot run never fails a run
    // whose stories all passed.
    const endReport = await runEndPhaseReported(options, _runnerCompletionDeps, completionResult, {
      now: _runnerCompletionDeps.now,
      gate,
    });
    // US-004: only "completed" with an explicit negative verdict is downgraded.
    const nextStatus = workflowFinalRunStatus(options.statusWriter.runStatus, endReport.workflowPassed);
    if (nextStatus !== options.statusWriter.runStatus) options.statusWriter.setRunStatus(nextStatus);
    return { advisoryFindings, endReport };
  } finally {
    gate.ensureSafely(() => {
      const durationMs = _runnerCompletionDeps.now() - options.startTime;
      return {
        durationMs,
        storiesDurationMs: durationMs,
        featureWorkflowDurationMs: 0,
        totalCost: completionResult.reportedTotal,
        workflowPassed: false,
      };
    });
    // Awaits hook delivery on the rejection path too (bounded by the bus's settle deadline).
    await pipelineEventBus.drain();
  }
}
