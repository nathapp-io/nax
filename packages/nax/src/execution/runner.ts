/**
 * Execution Runner — The Core Loop
 *
 * Orchestrates the agent loop:
 * 1. Load PRD → find next story/batch
 * 2. Run pipeline for each story/batch
 * 3. Handle pipeline results (escalate, mark complete, etc.)
 * 4. Loop until complete or blocked
 *
 * Delegates to extracted modules for each phase:
 * - runner-setup.ts: Initial setup (PRD, status, loggers)
 * - runner-execution.ts: Parallel/sequential execution
 * - runner-completion.ts: Acceptance loop, hooks, metrics
 */

import { totalSpendUsd } from "@/runtime";
import type { NaxConfig } from "../config";
import { PluginProviderCache, ProviderWeightsCache } from "../context/engine";
import { NaxError } from "../errors";
import type { LoadedHooksConfig } from "../hooks";
import { fireHook } from "../hooks";
import { getSafeLogger } from "../logger";
import type { StoryMetrics } from "../metrics";
import type { PipelineEventEmitter } from "../pipeline/events";
import { countStories, isComplete } from "../prd";
import type { PRD } from "../prd/types";
import { activateRunState, type RunStateHandle, repairRunState } from "../runstate";
import { gitWithTimeout } from "../utils/git";
import { NAX_VERSION } from "../version";
import { _workflowResumeDeps } from "./checkpoint";
import { stopHeartbeat } from "./crash-recovery";
import type { RunCleanupOptions } from "./lifecycle/run-cleanup";
import { liveRunTotalCost } from "./run-cost-reconcile";
import { buildRunId } from "./run-id";
import { runCompletionPhase } from "./runner-completion";
import { runExecutionPhase } from "./runner-execution";
import { runSetupPhase } from "./runner-setup";

/**
 * Injectable dependencies for testing (avoids mock.module() which leaks in Bun 1.x).
 * @internal - test use only.
 */
export const _runnerDeps = {
  fireHook,
  runSetupPhase,
  activateRunState,
  runExecutionPhase,
  runCompletionPhase,
  // Dynamic import (matching _runnerCompletionDeps' pattern) rather than a static
  // one in the finally block: run-cleanup pulls in the plugins barrel, and a
  // static import would add a load-time edge back into this module's own tree.
  async cleanupRun(opts: RunCleanupOptions): Promise<void> {
    const { cleanupRun } = await import("./lifecycle/run-cleanup");
    return cleanupRun(opts);
  },
};

/**
 * Guards `run()` against reentrant/concurrent invocation in the same process.
 * `run()` mutates the module-global `_workflowResumeDeps.mode` for its own
 * duration and restores the original in its `finally`. A second `run()`
 * starting while one is still in flight would race on that global: the second
 * call's save/restore would clobber the first call's mode mid-run, so
 * `buildStoryEnv` would read the wrong resume decision. There is currently no
 * legitimate concurrent-`run()` caller (stories run one at a time within a
 * single `run()`, not across separate `run()` calls) — this guard turns a
 * silent, hard-to-diagnose corruption into an immediate, explicit failure if
 * that assumption is ever violated.
 * @internal - test use only.
 */
export const _runnerReentrancyGuard = { inFlight: false };

/** Run options */

export interface RunOptions {
  /** Path to prd.json */
  prdPath: string;
  /** Working directory */
  workdir: string;
  /** Ngent config */
  config: NaxConfig;
  /** Hooks config */
  hooks: LoadedHooksConfig;
  /** Feature name */
  feature: string;
  /** Feature directory (for progress logging) */
  featureDir?: string;
  /** Dry run */
  dryRun: boolean;
  /** Retained for compatibility; ignored. Every run is unbatched. */
  useBatch?: boolean;
  /** Retained for compatibility; ignored. Every run is sequential. */
  parallel?: number;
  /** Optional event emitter for TUI integration */
  eventEmitter?: PipelineEventEmitter;
  /** Path to write a machine-readable JSON status file */
  statusFile: string;
  /** Path to JSONL log file (for crash recovery) */
  logFilePath?: string;
  /** Formatter verbosity mode for headless stdout (default: "normal") */
  formatterMode?: "quiet" | "normal" | "verbose" | "json";
  /** Whether running in headless mode (vs TUI mode) */
  headless?: boolean;
  /** Chat-launched run's ask directory and memory-only stdin secret. */
  chatAsksDir?: string;
  chatAskSecret?: Uint8Array;
  /** Skip precheck validations (for advanced users) */
  skipPrecheck?: boolean;
  /** Pre-built AgentStreamEventBus so the TUI can subscribe to live agent events. */
  agentStreamEvents?: import("../runtime").IAgentStreamEventBus;
  /**
   * Resume mode for checkpoint seeding, read by the workflow stage through
   * `_workflowResumeDeps`:
   *   - `"auto"` (default): resume from the feature's workflow record.
   *   - `"fresh"` / `"no-resume"`: ignore the prior record and start over.
   * Driven by `nax run --fresh` / `--no-resume` flags and `nax resume`.
   */
  resumeMode?: import("./checkpoint").ResumeMode;
  /**
   * Run identifier. When supplied (e.g. by `nax resume`, which builds one
   * via `buildRunId` so the resumed log file matches the run it records),
   * used verbatim — every phase of the run, the log file name, the
   * status.json `run.id`, and the cleanup hook all see the same id.
   *
   * When absent, the runner builds one with `buildRunId(workdir, new Date())`
   * so two worktrees of one project at the same ISO timestamp no longer
   * collide on `run-<iso>`. US-005.
   */
  runId?: string;
  /** #2819 (`nax run --publish-only`): every story has passed; rerun only the workflow's publish step. */
  publishOnly?: boolean;
}

/** Run result */
export interface RunResult {
  success: boolean;
  iterations: number;
  storiesCompleted: number;
  totalCost: number;
  durationMs: number;
}

/**
 * Main execution loop
 */
export async function run(options: RunOptions): Promise<RunResult> {
  const {
    prdPath,
    workdir,
    config,
    hooks,
    feature,
    featureDir,
    dryRun,
    eventEmitter,
    statusFile,
    logFilePath,
    formatterMode = "normal",
    headless = false,
    skipPrecheck = false,
    agentStreamEvents,
    resumeMode = "auto",
    runId: callerRunId,
  } = options;

  // Every run dispatches one story at a time, including callers such as `nax resume`.
  const useBatch = false;

  // Reentrant/concurrent `run()` would race on the module-global
  // `_storyOrchestratorDeps` mutation below — see `_runnerReentrancyGuard`'s
  // docstring. Fail fast instead of silently corrupting checkpoint state.
  if (_runnerReentrancyGuard.inFlight) {
    throw new NaxError(
      "run() called while another run() is already in flight in this process — " +
        "concurrent runs would race on the shared checkpoint dep seam",
      "RUNNER_REENTRANT_CALL",
      { stage: "execution", feature },
    );
  }
  _runnerReentrancyGuard.inFlight = true;

  const startTime = Date.now();
  const runStartedAt = new Date().toISOString();
  // US-005: a caller (e.g. `nax resume`) may pin a runId so the resumed log
  // file matches the run it records. When absent, build one through
  // `buildRunId` — a single producer keyed on (workdir hash, ms-precision
  // timestamp) — so two worktrees of one project at the same ISO timestamp
  // no longer collide on `run-<iso>`.
  const runId = callerRunId ?? buildRunId(workdir, new Date(startTime));

  // US-003 — the workflow stage reads the resume mode from its own seam (see
  // _workflowResumeDeps): `execution/` cannot import `@/workflow`, so this is
  // how `--fresh` / `--no-resume` reaches `buildStoryEnv`'s resume decision.
  // Saved here so both restore points below can put the prior value back.
  const origWorkflowResumeMode = _workflowResumeDeps.mode;
  // Workflow mode only runs against a feature, so a feature-less run has no
  // workflow record to resume and no reason to touch the seam.
  if (featureDir) _workflowResumeDeps.mode = resumeMode;
  let iterations = 0;
  let storiesCompleted = 0;
  let totalCost = 0;
  let runCompleted = false;
  const allStoryMetrics: StoryMetrics[] = [];

  const pluginProviderCache = new PluginProviderCache();
  const providerWeightsCache = new ProviderWeightsCache();

  // Declare prd before crash handler setup to avoid TDZ if SIGTERM arrives during setup
  let prd: PRD | undefined;

  // ── Phase 1: Setup ──────────────────────────────────────────────────────────
  // Wrapped in try/catch so a setup-time throw still restores the workflow
  // resume mode written above — without this, a crash before the inner finally
  // would leave `_workflowResumeDeps.mode` mutated across the entire process
  // (test harnesses and any subsequent in-process runs).
  let setupResult: Awaited<ReturnType<typeof _runnerDeps.runSetupPhase>>;
  try {
    setupResult = await _runnerDeps.runSetupPhase({
      prdPath,
      workdir,
      config,
      hooks,
      feature,
      featureDir,
      dryRun,
      statusFile,
      logFilePath,
      runId,
      startedAt: runStartedAt,
      startTime,
      skipPrecheck,
      headless,
      chatAsksDir: options.chatAsksDir,
      chatAskSecret: options.chatAskSecret,
      formatterMode,
      agentStreamEvents,
      // #2006: the crash handlers must read a live total. `totalCost` here is
      // assigned only after the execution phase returns, so a mid-run SIGINT
      // used to write `run.complete` with `totalCost: 0`. Read the reconciled
      // boundary total (via the status writer) once the setup phase produced
      // it; once the signal path has drained the ledger, the aggregator
      // snapshot IS the full run spend — including the in-flight story a
      // mid-story signal would otherwise under-report (COST-1).
      getTotalCost: () =>
        liveRunTotalCost(
          totalCost,
          setupResult?.statusWriter.lastTotalCost ?? 0,
          setupResult ? totalSpendUsd(setupResult.runtime.costAggregator.snapshot()) : undefined,
        ),
      getIterations: () => iterations,
      // @design: BUG-017: Pass getters for run.complete event on SIGTERM
      getStoriesCompleted: () => {
        const current = setupResult?.statusWriter.currentPrd() ?? prd;
        return current ? countStories(current).passed : storiesCompleted;
      },
      getStoriesPassed: () => {
        const current = setupResult?.statusWriter.currentPrd() ?? prd;
        return current ? countStories(current).passed : 0;
      },
      getStoriesFailed: () => {
        const current = setupResult?.statusWriter.currentPrd() ?? prd;
        return current ? countStories(current).failed : 0;
      },
      getTotalStories: () => (prd ? countStories(prd).total : 0),
    });
  } catch (err) {
    _workflowResumeDeps.mode = origWorkflowResumeMode;
    _runnerReentrancyGuard.inFlight = false;
    throw err;
  }

  const {
    statusWriter,
    sessionManager,
    cleanupCrashHandlers,
    pluginRegistry,
    interactionChain,
    shutdownController,
    runtime,
    sealApprovals,
  } = setupResult;
  prd = setupResult.prd;
  const agentManager = runtime.agentManager;
  const agentGetFn = agentManager.getAgent.bind(agentManager);

  let runState: RunStateHandle | null = null;
  try {
    // #2497: track nax run state for this run's feature so agent damage is repaired.
    runState = feature ? await _runnerDeps.activateRunState({ runId, feature, root: workdir }) : null;
    // ── Phase 2: Execution ──────────────────────────────────────────────────────
    const executionResult = await _runnerDeps.runExecutionPhase(
      {
        prdPath,
        workdir,
        config,
        hooks,
        feature,
        featureDir,
        dryRun,
        useBatch,
        eventEmitter,
        statusWriter,
        statusFile,
        logFilePath,
        runId,
        startedAt: runStartedAt,
        startTime,
        formatterMode,
        headless,
        agentGetFn,
        abortSignal: shutdownController.signal,
        interactionChain,
        sessionManager,
        agentManager,
        pluginProviderCache,
        providerWeightsCache,
        runtime,
      },
      prd,
      pluginRegistry,
    );

    prd = executionResult.prd;
    iterations = executionResult.iterations;
    storiesCompleted = executionResult.storiesCompleted;
    totalCost = executionResult.totalCost;
    allStoryMetrics.push(...executionResult.allStoryMetrics);

    // ── Phase 3: Completion ────────────────────────────────────────────────────
    const completionResult = await _runnerDeps.runCompletionPhase({
      config,
      hooks,
      feature,
      workdir,
      prdPath,
      statusFile,
      logFilePath,
      runId,
      startedAt: runStartedAt,
      startTime,
      formatterMode,
      headless,
      featureDir,
      prd,
      allStoryMetrics,
      totalCost,
      storiesCompleted,
      storiesGateOpen: executionResult.storiesGateOpen ?? 0,
      iterations,
      statusWriter,
      pluginRegistry,
      eventEmitter,
      agentGetFn,
      sessionManager,
      agentManager,
      pluginProviderCache,
      deferredReview: executionResult.deferredReview,
      deferredReviewStartedAt: executionResult.deferredReviewStartedAt,
      exitReason: executionResult.exitReason,
      runtime,
      abortSignal: shutdownController.signal,
      interactionChain,
      ...(options.publishOnly === true ? { publishOnly: true } : {}),
    });

    const { durationMs, pluginGateFailed, reportedTotal, workflowPassed } = completionResult;
    runCompleted = true;
    // The completion phase's cost-aggregator-reconciled total is the authority
    // (status.json, the headless footer and the exit summary already use it).
    // Adopt it for the returned RunResult.totalCost AND the cleanupRun handoff
    // below — both read this same binding (the finally block included).
    totalCost = reportedTotal;

    return {
      success: isComplete(prd) && !pluginGateFailed && workflowPassed !== false,
      iterations,
      storiesCompleted,
      totalCost,
      durationMs,
    };
  } finally {
    const logger = getSafeLogger();
    try {
      logger?.debug("execution", "Runner finally block — starting cleanup");
      // US-003 — restore the workflow resume mode so subsequent in-process runs
      // (or test harnesses) are not contaminated. The setup-phase error path has
      // its own restore above; this one covers the success-and-throw-later path
      // through runExecutionPhase / runCompletionPhase.
      _workflowResumeDeps.mode = origWorkflowResumeMode;
      _runnerReentrancyGuard.inFlight = false;
      // Stop heartbeat on any exit (US-007)
      stopHeartbeat();
      // Cleanup crash handlers (MEM-1 fix)
      cleanupCrashHandlers();

      // Phase 3 (#477): sidecar sweep removed — SessionManager.closeStory() handles
      // session cleanup at story completion. Orphan sweep is via SessionManager.sweepOrphans().

      // Resolve current branch at runtime
      let branch = "";
      try {
        const { stdout, exitCode } = await gitWithTimeout(["branch", "--show-current"], workdir);
        if (exitCode === 0) branch = stdout.trim();
      } catch {
        // Branch resolution is non-critical
      }

      // #2490/#2497: idempotent repair; covers an execution-phase throw that
      // skipped the completion-phase repair. Never throws.
      await repairRunState({ trigger: "run-end", workdir });
      runState?.deactivate();

      // Execute cleanup operations
      logger?.debug("execution", "Runner finally — running cleanupRun");
      await _runnerDeps.cleanupRun({
        runId,
        // #2300 — the id the session temp dirs were created under. NOT `runId`:
        // `runtime.runId` is the `crypto.randomUUID()` that
        // `resolveDispatchLauncher` passed to `runTmpRoot`, and wiping under
        // `runId` removed a path that was never created.
        startTime,
        totalCost,
        storiesCompleted,
        prd,
        pluginRegistry,
        workdir,
        interactionChain,
        feature,
        prdPath,
        branch,
        version: NAX_VERSION,
        hooks,
        runCompleted,
        // US-004 — gated together with `runCompleted` to decide whether the
        // end-of-run scratchpad wipe fires. A dry run never wrote anything
        // to the scratchpad, so there is nothing to wipe.
        dryRun,
        outputDir: runtime.outputDir,
        globalDir: runtime.globalDir,
        projectKey: runtime.projectKey,
        logFilePath,
        config,
        // US-002: the seal built at setup. cleanupRun awaits it after the
        // post-run actions (which may dispatch agents) and plugin teardown.
        sealApprovals,
      });
      logger?.debug("execution", "Runner finally — cleanupRun done, run() returning");
    } finally {
      await runtime.close();
    }
  }
}

// Re-exports for backward compatibility with existing test imports
export { groupStoriesIntoBatches, type StoryBatch } from "./batching";
export { escalateTier } from "./escalation";
