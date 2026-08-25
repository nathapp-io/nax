/**
 * Runner Completion Phase
 *
 * Handles post-execution steps: acceptance loop, hooks, metrics, and cleanup.
 * Extracted from runner.ts for better code organization.
 */

import path from "node:path";
import { groupStoriesByPackage } from "@/acceptance";
import { loadConfigForWorkdir, type NaxConfig } from "@/config";
import type { FinishPhaseContext, FinishResult } from "@/finish";
import type { LoadedHooksConfig } from "@/hooks";
import { fireHook } from "@/hooks";
import { getSafeLogger } from "@/logger";
import type { StoryMetrics } from "@/metrics";
import { pipelineEventBus } from "@/pipeline";
import type { PipelineEventEmitter } from "@/pipeline/events";
import type { AgentGetFn } from "@/pipeline/types";
import type { PluginRegistry } from "@/plugins/registry";
import type { PRD } from "@/prd";
import { countStories, isComplete } from "@/prd";
import type { DispatchContext } from "@/runtime/dispatch-context";
import type { ISessionManager } from "@/session";
import { errorMessage } from "@/utils/errors";
import { autoCommitIfDirty, gitWithTimeout } from "@/utils/git";
import { stopHeartbeat, writeExitSummary } from "./crash-recovery";
import type { DeferredReviewResult } from "./deferred-review";
import type { ExitReason } from "./executor-types";
import type { AcceptanceLoopContext, AcceptanceLoopResult } from "./lifecycle/acceptance-loop";
import type { RunCompletionOptions, RunCompletionResult } from "./lifecycle/run-completion";
import type { AcceptancePhaseStatus } from "./status-file";
import { hookCtx } from "./story-context";

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
  iterations: number;
  // biome-ignore lint/suspicious/noExplicitAny: StatusWriter interface varies by platform
  statusWriter: any;
  pluginRegistry: PluginRegistry;
  eventEmitter?: PipelineEventEmitter;
  /** Protocol-aware agent resolver */
  agentGetFn?: AgentGetFn;
  /** Path to prd.json — required for acceptance fix story writes */
  prdPath: string;
  /**
   * Max parallel sessions, straight from RunnerOptions: undefined = sequential,
   * 0 = auto-detect, N > 0 = cap at N.
   *
   * The deferred-regression gate needs this to know whether its per-story gate
   * snapshots are causally ordered. It was never forwarded, so `isSequential`
   * was only ever set by tests and the parallel branch was dead in production —
   * snapshots reached the gate on every run, including parallel ones.
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
}

/**
 * Result from the completion phase.
 */
export interface RunnerCompletionResult {
  durationMs: number;
  runCompletedAt: string;
  /** False when the acceptance loop exhausted retries for any package. True when acceptance
   *  passed, was skipped, or was already passed on a prior run. Used by runner.ts to set
   *  RunResult.success — regression-gate outcome cannot override an acceptance failure. */
  acceptancePassed: boolean;
  /** True when a gating-mode deferred plugin reviewer failed. Factored into RunResult.success. */
  pluginGateFailed: boolean;
}

/**
 * Injectable dependencies for testing (avoids mock.module() which leaks in Bun 1.x).
 * @internal - test use only.
 */
export const _runnerCompletionDeps: {
  runAcceptanceLoop(ctx: AcceptanceLoopContext): Promise<AcceptanceLoopResult>;
  handleRunCompletion(opts: RunCompletionOptions): Promise<RunCompletionResult>;
  loadConfigForWorkdir(rootConfigPath: string, workdir?: string): Promise<NaxConfig>;
  runFinishPhase(ctx: FinishPhaseContext): Promise<FinishResult | null>;
} = {
  async runAcceptanceLoop(ctx) {
    const { runAcceptanceLoop } = await import("./lifecycle/acceptance-loop");
    return runAcceptanceLoop(ctx);
  },
  async handleRunCompletion(opts) {
    const { handleRunCompletion } = await import("./lifecycle/run-completion");
    return handleRunCompletion(opts);
  },
  loadConfigForWorkdir,
  // Dynamic import (matching handleRunCompletion's own pattern above), not a
  // static one: the finish module imports the CLI barrel, and a static import
  // here would create a load-time cycle back through this module's own tree.
  async runFinishPhase(ctx) {
    const { runFinishPhase } = await import("@/finish");
    return runFinishPhase(ctx);
  },
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
    acceptanceEnabled: options.config.acceptance?.enabled,
    isComplete: isComplete(options.prd),
  });

  // Track whether acceptance passed (or was skipped/already-passed) — surfaced in
  // RunnerCompletionResult so runner.ts can include it in RunResult.success.
  let acceptancePassed = true;

  // Check post-run status to determine if phases can be skipped on rerun
  const postRunStatus = options.statusWriter.getPostRunStatus?.();
  const acceptanceAlreadyPassed = postRunStatus?.acceptance?.status === "passed";
  const regressionAlreadyPassed = postRunStatus?.regression?.status === "passed";

  if (acceptanceAlreadyPassed && regressionAlreadyPassed) {
    logger?.info("execution", "Post-run phases already passed — skipping acceptance and regression");
  } else {
    if (acceptanceAlreadyPassed) {
      logger?.info("execution", "Acceptance already passed — skipping acceptance phase");
    } else if (options.config.acceptance.enabled && isComplete(options.prd)) {
      options.statusWriter.setPostRunPhase("acceptance", { status: "running" });
      const acceptanceStartTime = Date.now();
      pipelineEventBus.emit({ type: "postrun:phase:started", phase: "acceptance" });

      // Compute per-package acceptance test paths from PRD story workdirs.
      // This is necessary because preRunCtx.acceptanceTestPaths is ephemeral and
      // not propagated here; it's also skipped entirely when the PRD is already
      // complete at run start (re-run). groupStoriesByPackage is the SSOT.
      const acceptanceTestPaths = options.featureDir
        ? await Promise.all(
            (
              await groupStoriesByPackage(
                options.prd,
                options.workdir,
                options.feature,
                options.config.acceptance.testPath,
                options.config.project?.language,
              )
            ).map(async (g) => {
              const relativeWorkdir = path.relative(options.workdir, g.packageDir);
              let groupConfig = options.config;

              if (relativeWorkdir && relativeWorkdir !== ".") {
                try {
                  groupConfig = await _runnerCompletionDeps.loadConfigForWorkdir(
                    path.join(options.workdir, ".nax", "config.json"),
                    relativeWorkdir,
                  );
                } catch (error) {
                  logger?.warn("execution", "Falling back to root config for package acceptance settings", {
                    packageDir: g.packageDir,
                    relativeWorkdir,
                    error: errorMessage(error),
                  });
                }
              }

              return {
                testPath: g.testPath,
                packageDir: g.packageDir,
                testFramework: groupConfig.project?.testFramework,
                commandOverride: groupConfig.acceptance.command,
                storyCount: g.stories.length,
                acceptanceEnabled: groupConfig.acceptance.enabled,
              };
            }),
          )
        : undefined;

      let acceptanceResult: Awaited<ReturnType<typeof _runnerCompletionDeps.runAcceptanceLoop>>;
      try {
        acceptanceResult = await _runnerCompletionDeps.runAcceptanceLoop({
          config: options.config,
          prd: options.prd,
          prdPath: options.prdPath,
          workdir: options.workdir,
          featureDir: options.featureDir,
          hooks: options.hooks,
          feature: options.feature,
          totalCost: options.totalCost,
          iterations: options.iterations,
          storiesCompleted: options.storiesCompleted,
          allStoryMetrics: options.allStoryMetrics,
          pluginRegistry: options.pluginRegistry,
          eventEmitter: options.eventEmitter,
          statusWriter: options.statusWriter,
          agentGetFn: options.agentGetFn,
          agentManager: options.agentManager,
          sessionManager: options.sessionManager,
          runtime: options.runtime,
          abortSignal: options.abortSignal,
          acceptanceTestPaths,
          // US-004 (AC-35): forward the prior run's missing-target packages
          // onto the context so a resumed run's acceptance loop is invoked
          // with that history available, rather than the resume decision
          // (driven by postRunStatus.acceptance.status, see
          // acceptanceAlreadyPassed above) losing it entirely.
          skippedPackages: postRunStatus?.acceptance?.skippedPackages,
        });
      } catch (err) {
        // A thrown error here would otherwise leave "acceptance" permanently
        // "running" in the TUI/status.json — no postrun:phase:completed ever
        // fires (post-impl-review quality finding).
        pipelineEventBus.emit({
          type: "postrun:phase:completed",
          phase: "acceptance",
          passed: false,
          durationMs: Date.now() - acceptanceStartTime,
        });
        throw err;
      }

      const lastRunAt = new Date().toISOString();
      const acceptanceDurationMs = Date.now() - acceptanceStartTime;
      if (acceptanceResult.success) {
        // US-004 (AC-4): explicitly clear skippedPackages on the passed
        // transition so a stale list from a prior failed run is not
        // retained. StatusWriter merges updates shallowly, so omitting
        // the field would leave the previous value in place.
        options.statusWriter.setPostRunPhase("acceptance", {
          status: "passed",
          lastRunAt,
          skippedPackages: undefined,
        });
        pipelineEventBus.emit({
          type: "postrun:phase:completed",
          phase: "acceptance",
          passed: true,
          durationMs: acceptanceDurationMs,
          details: {
            retries: acceptanceResult.retries ?? 0,
            failedACCount: acceptanceResult.failedACs?.length ?? 0,
            // ADR-022 replaced fix-story PRD mutation with in-place runFixCycle
            // rectification — the acceptance loop never appends US-FIX-* stories,
            // so this is always accurately 0, not an unmeasured placeholder.
            fixStoriesCreated: 0,
          },
        });
      } else {
        acceptancePassed = false;
        // US-004: surface missing-target packages on the failed phase so a
        // resumed run can re-evaluate them. The field is always written —
        // explicitly undefined when this failure has none — because
        // StatusWriter merges updates shallowly and would otherwise leave a
        // stale list from an earlier missing-target failure in place.
        const failureUpdate: Partial<AcceptancePhaseStatus> = {
          status: "failed",
          failedACs: acceptanceResult.failedACs ?? [],
          retries: acceptanceResult.retries ?? 0,
          lastRunAt,
          skippedPackages:
            acceptanceResult.skippedPackages && acceptanceResult.skippedPackages.length > 0
              ? acceptanceResult.skippedPackages
              : undefined,
        };
        options.statusWriter.setPostRunPhase("acceptance", failureUpdate);
        pipelineEventBus.emit({
          type: "postrun:phase:completed",
          phase: "acceptance",
          passed: false,
          durationMs: acceptanceDurationMs,
          details: {
            retries: acceptanceResult.retries ?? 0,
            failedACCount: acceptanceResult.failedACs?.length ?? 0,
            fixStoriesCreated: 0,
          },
        });
      }

      Object.assign(options, {
        prd: acceptanceResult.prd,
        totalCost: acceptanceResult.totalCost,
        iterations: acceptanceResult.iterations,
        storiesCompleted: acceptanceResult.storiesCompleted,
      });
    }
  }

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
    iterations: options.iterations,
    startTime: options.startTime,
    workdir: options.workdir,
    statusWriter: options.statusWriter,
    config: options.config,
    agentManager: options.agentManager,
    skipRegression: regressionAlreadyPassed,
    sessionManager: options.sessionManager,
    pluginProviderCache: options.pluginProviderCache,
    deferredReview: options.deferredReview,
    deferredReviewStartedAt: options.deferredReviewStartedAt,
    exitReason: options.exitReason,
    runtime: options.runtime,
    abortSignal: options.abortSignal,
    // RunnerOptions.parallel: undefined = sequential. Anything else fans stories
    // out across worktrees, where `completedAt` order is not causal and per-story
    // gate state does not reflect the merged repo — so the regression gate must
    // withhold its snapshots rather than attribute blame from them.
    isSequential: options.parallel === undefined,
  });

  const { durationMs, runCompletedAt, finalCounts, reportedTotal, pluginGateFailed } = completionResult;

  // Write feature-level status (SFC-002).
  // Use reportedTotal (cost-aggregator-corrected) instead of the legacy
  // options.totalCost accumulator, which drops acceptance/review/diagnosis
  // spend (issue #909).
  if (options.featureDir) {
    // A gating-mode plugin reviewer failure fails the run even when all stories passed
    // (#1146 G2). Folded in here — not via setRunStatus inside handleRunCompletion, which
    // this line would otherwise clobber back to "completed".
    // pluginGateFailed is checked first so a genuine gate failure is never masked by a
    // cost-limit stop — the budget being hit doesn't make a reviewer failure less real.
    const finalStatus = pluginGateFailed
      ? "failed"
      : options.exitReason === "cost-limit"
        ? "cost-limit"
        : isComplete(options.prd)
          ? "completed"
          : "failed";
    options.statusWriter.setRunStatus(finalStatus);
    await options.statusWriter.writeFeatureStatus(options.featureDir, reportedTotal, options.iterations);
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

  const mutationSummaries = [...(options.runtime?.mutationSummaries?.values() ?? [])];
  const survivorCount = mutationSummaries.reduce((count, summary) => count + summary.survivors.length, 0);
  if (survivorCount > 0) {
    logger?.warn("mutation-check", "Surviving mutants detected at run end", {
      storyId: "_run",
      survivorCount,
    });
  }

  // Output run footer in headless mode
  if (options.headless && options.formatterMode !== "json") {
    const { outputAdvisoryFindingsSummary, outputMutationSummary, outputRunFooter } = await import(
      "./lifecycle/headless-formatter"
    );
    outputAdvisoryFindingsSummary(advisoryFindings, options.formatterMode);
    outputMutationSummary(mutationSummaries, options.formatterMode);
    outputRunFooter({
      finalCounts: {
        total: finalCounts.total,
        passed: finalCounts.passed,
        failed: finalCounts.failed,
        skipped: finalCounts.skipped,
      },
      durationMs,
      totalCost: reportedTotal,
      startedAt: options.startedAt,
      completedAt: runCompletedAt,
      formatterMode: options.formatterMode,
    });
  }

  // Stop heartbeat and write exit summary (US-007)
  logger?.debug("execution", "Completion phase — stopping heartbeat and writing exit summary");
  stopHeartbeat();
  await writeExitSummary(options.logFilePath, reportedTotal, options.iterations, options.storiesCompleted, durationMs);

  // Commit status.json and any other nax runtime files left dirty at run end
  logger?.debug("execution", "Completion phase — auto-committing dirty files");
  await autoCommitIfDirty(
    options.workdir,
    "run.complete",
    "run-summary",
    options.feature,
    options.runtime?.dirtyWorktrees,
  );

  // Native finish phase (design 4.1). Must precede runtime.close(), whose own
  // comment below says it drains the cost aggregator and aborts the signal —
  // after it, finish's spend never reaches totalCost and its deadline signal
  // is already fired. Fail-open: a finish that cannot run never fails a run
  // whose stories all passed.
  try {
    await _runnerCompletionDeps.runFinishPhase({
      runtime: options.runtime,
      config: options.config,
      feature: options.feature,
      workdir: options.workdir,
      branch: await resolveBranch(options.workdir),
      runId: options.runId,
      agentName: options.agentManager.getDefault(),
      abortSignal: options.abortSignal,
      storySummary: finishStorySummary(options),
      statusWriter: options.statusWriter,
    });
  } catch (err) {
    logger?.warn("finish", "Finish phase failed; the run is unaffected", {
      storyId: "_run",
      error: errorMessage(err),
    });
  }

  // Close the NaxRuntime — flushes auditors, drains cost aggregator, aborts signal
  await options.runtime?.close();

  logger?.debug("execution", "Completion phase done — returning to runner");

  return {
    durationMs,
    runCompletedAt,
    acceptancePassed,
    pluginGateFailed,
  };
}

/**
 * The three counts `shouldRunFinish` gates on, in the shape the plugin's own
 * gate read them.
 *
 * `completed` is `options.storiesCompleted` — **not** `countStories(prd).passed`
 * — for every run that actually executed a story. `buildPostRunContext`
 * (`src/execution/lifecycle/run-cleanup.ts:151-156`) builds
 * `PostRunContext.storySummary.completed` from the runner's `storiesCompleted`
 * counter and takes only `failed`/`skipped`/`paused` from `countStories`.
 * Substituting `passed` here would silently change the gate the native phase
 * inherits.
 *
 * The one narrow exception (#1671): a *resumed* run whose PRD is already
 * fully complete executes no story at all, so `storiesCompleted` stays 0 even
 * though the completion phase just did real work (deferred review, cleanup).
 * `unified-executor.ts:171` takes that exact "all stories already complete"
 * branch behind `isComplete(prd)` — the same predicate used below — so when
 * `storiesCompleted === 0` and `isComplete(prd)` is true, the fallback reports
 * `counts.passed` instead. `isComplete` rather than `counts.passed > 0`
 * because it additionally rules out any `pending`/`blocked` story; a run that
 * merely has one passed story among others still unstarted must not look
 * complete to `shouldRunFinish`. Any run that executed at least one story
 * keeps its own `storiesCompleted` count untouched.
 *
 * `countStories().failed` already folds in `regression-failed`, matching the
 * classification the deferred regression gate uses.
 */
function finishStorySummary(options: RunnerCompletionOptions): { completed: number; failed: number; paused: number } {
  const counts = countStories(options.prd);
  const completed =
    options.storiesCompleted === 0 && isComplete(options.prd) ? counts.passed : options.storiesCompleted;
  return { completed, failed: counts.failed, paused: counts.paused };
}

/**
 * The branch finish would open a PR from.
 *
 * There is no `currentBranch` helper in `@/utils/git` — an earlier draft of
 * this plan invented one. This is the idiom `runner.ts:344-348` already uses
 * to resolve the branch it hands `cleanupRun`, including the fail-closed
 * empty-string default: `isFeatureBranch("")` is false, so an unresolvable
 * branch makes finish stand down rather than guess.
 */
async function resolveBranch(workdir: string): Promise<string> {
  try {
    const { stdout, exitCode } = await gitWithTimeout(["branch", "--show-current"], workdir);
    return exitCode === 0 ? stdout.trim() : "";
  } catch {
    return "";
  }
}
