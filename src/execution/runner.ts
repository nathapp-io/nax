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
import { gitWithTimeout } from "../utils/git";
import { NAX_VERSION } from "../version";
import { applyRecordGreenDeps, applyResumeModeDeps } from "./checkpoint";
import { stopHeartbeat } from "./crash-recovery";
import { runCompletionPhase } from "./runner-completion";
import { runExecutionPhase } from "./runner-execution";
import { runSetupPhase } from "./runner-setup";
import { _storyOrchestratorDeps } from "./story-orchestrator";

/**
 * Injectable dependencies for testing (avoids mock.module() which leaks in Bun 1.x).
 * @internal - test use only.
 */
export const _runnerDeps = {
  fireHook,
  runSetupPhase,
};

// Re-export for backward compatibility
export { resolveMaxAttemptsOutcome } from "./escalation";

/**
 * Guards `run()` against reentrant/concurrent invocation in the same process.
 * `run()` saves and mutates the module-global `_storyOrchestratorDeps`
 * (`loadCheckpoints` / `recordGreen`) for its own duration and restores the
 * originals in its `finally`. A second `run()` starting while one is still
 * in flight would race on that global: the second call's save/restore would
 * clobber the first call's checkpoint deps mid-run, corrupting which
 * feature's `checkpoint.jsonl` phases get read/recorded. There is currently
 * no legitimate concurrent-`run()` caller (parallel execution fans out
 * within a single `run()`, not across separate `run()` calls) — this guard
 * turns a silent, hard-to-diagnose cross-feature corruption into an
 * immediate, explicit failure if that assumption is ever violated.
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
  /** Enable story batching (default: true) */
  useBatch?: boolean;
  /** Max parallel sessions: undefined=sequential, 0=auto-detect, N>0=cap at N */
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
  /** Skip precheck validations (for advanced users) */
  skipPrecheck?: boolean;
  /** Pre-built AgentStreamEventBus so the TUI can subscribe to live agent events. */
  agentStreamEvents?: import("../runtime").IAgentStreamEventBus;
  /**
   * Resume mode for checkpoint seeding. The orchestrator's
   * `_storyOrchestratorDeps.loadCheckpoints` is overridden based on this:
   *   - `"auto"` (default): read real checkpoint.jsonl when present.
   *   - `"fresh"` / `"no-resume"`: always return empty Map (no skip phases).
   * Driven by `nax run --fresh` / `--no-resume` flags.
   */
  resumeMode?: import("./checkpoint").ResumeMode;
}

/** Run result */
export interface RunResult {
  success: boolean;
  iterations: number;
  storiesCompleted: number;
  totalCost: number;
  durationMs: number;
  /**
   * Sum of every story's `StoryMetrics.reviewsFailedOpen` (ENH-20) — review
   * checks that degraded to a fail-open pass rather than being actually
   * evaluated. Omitted (not zero) when no story fail-opened, so callers can
   * gate a summary line on presence rather than a `> 0` check.
   */
  reviewsFailedOpen?: number;
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
    useBatch = true,
    eventEmitter,
    statusFile,
    parallel,
    logFilePath,
    formatterMode = "normal",
    headless = false,
    skipPrecheck = false,
    agentStreamEvents,
    resumeMode = "auto",
  } = options;

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
  const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;

  // US-004 — wire the orchestrator's checkpoint deps based on the resume mode.
  // Auto: read real checkpoint.jsonl when present. Fresh / no-resume: ignore any
  // prior checkpoint and seed an empty skip plan. `recordGreen` is always wired
  // to a real CheckpointWriter so green phases are durably recorded regardless
  // of resume mode — without this, checkpoint.jsonl is never written and resume
  // has nothing to seed from on the next run. Save the original deps so we can
  // restore them in the outer finally — even if runSetupPhase throws before we
  // enter the inner try block below.
  const origLoadCheckpoints = _storyOrchestratorDeps.loadCheckpoints;
  const origRecordGreen = _storyOrchestratorDeps.recordGreen;
  // Feature-less runs have no directory to durably record checkpoints under —
  // `join("", "checkpoint.jsonl")` resolves to a bare relative path, which lands in
  // whatever the process CWD happens to be and cross-seeds unrelated runs (BUG-40).
  // Leave the default no-op stubs wired in that case instead of pointing them at CWD.
  if (featureDir) {
    applyResumeModeDeps(featureDir, resumeMode);
    applyRecordGreenDeps(featureDir, runId);
  }
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
  // Wrapped in try/catch so a setup-time throw still restores the orchestrator
  // dep we overrode above — without this, a crash before the inner finally
  // would leave _storyOrchestratorDeps.loadCheckpoints mutated across the
  // entire process (test harnesses and any subsequent in-process runs).
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
      formatterMode,
      agentStreamEvents,
      getTotalCost: () => totalCost,
      getIterations: () => iterations,
      // @design: BUG-017: Pass getters for run.complete event on SIGTERM
      getStoriesCompleted: () => storiesCompleted,
      getTotalStories: () => (prd ? countStories(prd).total : 0),
    });
  } catch (err) {
    _storyOrchestratorDeps.loadCheckpoints = origLoadCheckpoints;
    _storyOrchestratorDeps.recordGreen = origRecordGreen;
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
  } = setupResult;
  prd = setupResult.prd;
  const agentManager = runtime.agentManager;
  const agentGetFn = agentManager.getAgent.bind(agentManager);

  try {
    // ── Phase 2: Execution ──────────────────────────────────────────────────────
    const executionResult = await runExecutionPhase(
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
        parallel,
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
    const completionResult = await runCompletionPhase({
      config,
      hooks,
      feature,
      workdir,
      parallel,
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
    });

    const { durationMs, acceptancePassed, pluginGateFailed } = completionResult;
    runCompleted = true;

    const reviewsFailedOpen = allStoryMetrics.reduce((sum, m) => sum + (m.reviewsFailedOpen ?? 0), 0);

    return {
      success: isComplete(prd) && acceptancePassed && !pluginGateFailed,
      iterations,
      storiesCompleted,
      totalCost,
      durationMs,
      ...(reviewsFailedOpen > 0 ? { reviewsFailedOpen } : {}),
    };
  } finally {
    const logger = getSafeLogger();
    try {
      logger?.debug("execution", "Runner finally block — starting cleanup");
      // US-004 — restore the orchestrator's default checkpoint dep stubs so
      // subsequent in-process runs (or test harnesses) are not contaminated.
      // The setup-phase error path has its own restore above; this one covers
      // the success-and-throw-later path through runExecutionPhase /
      // runCompletionPhase.
      _storyOrchestratorDeps.loadCheckpoints = origLoadCheckpoints;
      _storyOrchestratorDeps.recordGreen = origRecordGreen;
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

      // Execute cleanup operations
      logger?.debug("execution", "Runner finally — running cleanupRun");
      const { cleanupRun } = await import("./lifecycle/run-cleanup");
      await cleanupRun({
        runId,
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
        outputDir: runtime.outputDir,
        globalDir: runtime.globalDir,
        projectKey: runtime.projectKey,
        curatorRollupPath: runtime.curatorRollupPath,
        logFilePath,
        config,
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
