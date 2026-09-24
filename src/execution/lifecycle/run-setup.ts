/**
 * Run Setup — Orchestrator
 *
 * Phase 1 of runner.run(). Wires the run-scoped state (status writer, runtime,
 * crash handlers, locks, plugins, PRD) before the execution phase begins.
 *
 * Structure:
 *   - setupRun() body: pre-lock wiring → acquire checkout lock → acquire
 *     feature lock → delegate to initializeAfterLock → assemble RunSetupResult.
 *   - Lock acquisition wraps in try/catch: feature-lock refusal releases the
 *     checkout lock before throwing; post-lock init failure is caught by the
 *     FIX-H16 inner catch in `run-setup-init.ts` which releases both locks in
 *     reverse order.
 *   - MEM-1 outer try/catch: uninstalls crash handlers and closes the runtime
 *     if anything in setup throws (loadPRD failure, lock acquisition failure,
 *     etc.). See the rationale comment above the catch for the full story.
 *   - Pre-flight warnings (warnFallbackMisconfiguration, warnProfileMismatch)
 *     live in run-setup-warnings.ts and are re-exported here for back-compat
 *     with existing imports of `@/execution/lifecycle/run-setup`.
 *
 * Split out of a single 600-line file (the project's hard limit) into:
 *   - run-setup-warnings.ts — pure-function warnings
 *   - run-setup-init.ts    — post-lock initialization
 */

import path from "node:path";
import type { NaxConfig } from "@/config";
import { LockAcquisitionError, NaxError } from "@/errors";
import { createRtkInterceptor } from "@/execution/interceptors/rtk";
import type { LoadedHooksConfig } from "@/hooks";
import type { InteractionChain } from "@/interaction";
import { initInteractionChain } from "@/interaction";
import { getSafeLogger } from "@/logger";
import { pipelineEventBus } from "@/pipeline/event-bus";
import type { AgentGetFn } from "@/pipeline/types";
import type { PluginRegistry } from "@/plugins/registry";
import type { PRD } from "@/prd";
import { loadPRD } from "@/prd";
import { detectProjectProfile } from "@/project";
import { createRuntime, type NaxRuntime } from "@/runtime";
import { SessionManager, sweepFeatureTranscripts } from "@/session";
import { discoverWorkspacePackages } from "@/test-runners";
import { _gitToolDeps } from "@/tools";
import { errorMessage } from "@/utils/errors";
import { gitSpawnEnv } from "@/utils/git-env";
import { installCrashHandlers } from "../crash-recovery";
import { acquireFeatureLock, type FeatureLockResult } from "../feature-lock";
import { acquireLock, releaseLock } from "../helpers";
import { closeAllRunSessions } from "../session-manager-runtime";
import { StatusWriter } from "../status-writer";
import { initializeAfterLock } from "./run-setup-init";
import { warnFallbackMisconfiguration, warnInertBashStages } from "./run-setup-warnings";

// Re-export warnings for back-compat with tests and other callers that import
// from `@/execution/lifecycle/run-setup` directly.
export { warnFallbackMisconfiguration, warnInertBashStages, warnProfileMismatch } from "./run-setup-warnings";

/**
 * Injectable deps for run-setup (enables testing without heavy side-effects).
 *
 * `detectProjectProfile` and `sweepFeatureTranscripts` are read at call time
 * inside `initializeAfterLock` — passed through the `deps` parameter so the
 * init helper doesn't need to import this module (which would cycle).
 */
export const _runSetupDeps = {
  detectProjectProfile,
  createRuntime,
  installCrashHandlers,
  sweepFeatureTranscripts,
  // US-002 seams: `setupRun` acquires the checkout lock then the feature lock
  // through these injectable entries. Added so tests can force refusals /
  // record ordering; the acquisition sequence itself is the implementer's work.
  acquireLock,
  acquireFeatureLock,
};

export interface RunSetupOptions {
  prdPath: string;
  workdir: string;
  config: NaxConfig;
  hooks: LoadedHooksConfig;
  feature: string;
  featureDir?: string;
  dryRun: boolean;
  statusFile: string;
  logFilePath?: string;
  runId: string;
  startedAt: string;
  startTime: number;
  skipPrecheck: boolean;
  headless: boolean;
  formatterMode: "quiet" | "normal" | "verbose" | "json";
  getTotalCost: () => number;
  getIterations: () => number;
  // @design: BUG-017: Additional getters for run.complete event on SIGTERM
  getStoriesCompleted: () => number;
  getTotalStories: () => number;
  /** Protocol-aware agent resolver — passed from runner.ts registry */
  agentGetFn?: AgentGetFn;
  /** Per-run AgentManager (ADR-012). When provided, validateCredentials() is called at run start. */
  agentManager?: import("@/agents").IAgentManager;
  /** Pre-built AgentStreamEventBus to inject into the runtime so external subscribers (e.g. TUI) can receive events. */
  agentStreamEvents?: import("@/runtime").IAgentStreamEventBus;
}

export interface RunSetupResult {
  statusWriter: StatusWriter;
  sessionManager: SessionManager;
  cleanupCrashHandlers: () => void;
  pluginRegistry: PluginRegistry;
  prd: PRD;
  storyCounts: {
    total: number;
    passed: number;
    pending: number;
    failed: number;
  };
  interactionChain: InteractionChain | null;
  /**
   * Shutdown controller (fix for v0.63.0-canary.8 Issue 5).
   * Aborted by the crash/signal handler on first fatal signal. Threaded into
   * AgentRunOptions.abortSignal so in-flight adapter retry loops can bail
   * instead of spawning new work during teardown.
   */
  shutdownController: AbortController;
  /** NaxRuntime created during setup — exposes agentManager, sessionManager, etc. */
  runtime: NaxRuntime;
}

/**
 * Execute initial setup phase.
 *
 * Layout: pre-lock wiring → acquire checkout lock → acquire feature lock →
 * delegate post-lock init to `initializeAfterLock` → assemble and return
 * RunSetupResult. The MEM-1 outer try/catch below ensures crash handlers are
 * uninstalled and the runtime is closed on any setup failure, even before
 * either lock was acquired.
 */
export async function setupRun(options: RunSetupOptions): Promise<RunSetupResult> {
  const logger = getSafeLogger();

  // AC-35: pre-flight warning for unconfigured fallback candidates
  warnFallbackMisconfiguration(options.config, options.agentGetFn, logger);

  // US-003 AC14/AC15: pre-flight warning for stages whose resolved Bash
  // grants are empty under a gated/escalate mode — silent otherwise (AC13).
  warnInertBashStages(options.config, logger);

  if (options.agentManager) {
    await options.agentManager.validateCredentials();
  }

  const {
    prdPath,
    workdir,
    config,
    feature,
    dryRun,
    statusFile,
    logFilePath,
    runId,
    startedAt,
    startTime,
    skipPrecheck,
    headless,
    formatterMode,
    getTotalCost,
    getIterations,
  } = options;

  // ── Command interception ────────────────────────────────────────────────────
  // Installed unconditionally, once per run, before the first tool dispatch:
  // setupRun is Phase 1 of runner.run(), and the Git tool is only consulted
  // from Phase 2 agent sessions, so this always precedes the first git call.
  // `enabled` governs behaviour, not whether the interceptor exists — the state
  // record is written every run, which is what makes spec §7 A/B arms
  // distinguishable. Entry points that skip setupRun leave the seam undefined
  // and interception simply does not apply — fail-safe.
  const ci = config.execution.commandInterceptor;
  _gitToolDeps.interceptor = createRtkInterceptor({
    enabled: ci.enabled,
    verbs: ci.git.verbs,
  });

  // ── Status writer (encapsulates status file state and write logic) ───────
  const statusWriter = new StatusWriter(statusFile, config, {
    runId,
    feature,
    startedAt,
    dryRun,
    startTimeMs: startTime,
    pid: process.pid,
    // US-005: thread the run's workdir through so the snapshot written to
    // disk carries `run.workdir` for external readers (TUI, `nax status`).
    // The `workdir` local above has been in scope since :142.
    workdir,
  });

  // ── PID registry constructed by createRuntime (BUG-002) ────────
  const sessionManager = new SessionManager();

  // Shutdown controller — fires on first fatal signal. Threaded into
  // AgentRunOptions.abortSignal so the ACP adapter's retry loop stops
  // spawning fresh acpx processes during teardown (Issue 5).
  const shutdownController = new AbortController();

  // NaxRuntime — single owner of agentManager + sessionManager for this run.
  // Passes through the existing sessionManager and options.agentManager (if any)
  // so callers that pre-create an AgentManager for credential validation continue
  // to work (e.g. run-precheck validates credentials before handing off the manager).
  const runtime = _runSetupDeps.createRuntime(config, workdir, {
    parentSignal: shutdownController.signal,
    sessionManager,
    agentManager: options.agentManager,
    featureName: options.feature,
    agentStreamEvents: options.agentStreamEvents,
    // nax#1808: the auto-commit refusal reads runtime.dryRun; without this the
    // flag never leaves RunSetupOptions and the guard is inert in production.
    dryRun: options.dryRun,
  });

  // 2b: merge per-package .nax/mono/<pkg>/config.json into the runtime registry so
  // every packageView consumer (quality gates, smart-runner, context) sees the
  // package's own commands — not just root config. Failure is non-fatal (root fallback).
  try {
    const workspacePackages = await discoverWorkspacePackages(workdir);
    if (workspacePackages.length > 0) {
      await runtime.packages.hydrate(workspacePackages);
    }
  } catch (err) {
    getSafeLogger()?.warn("run-setup", "Per-package config hydration failed — using root config", {
      storyId: "_setup",
      error: errorMessage(err),
    });
  }

  // Cleanup stale PIDs from previous crashed runs
  await runtime.pidRegistry.cleanupStale();

  // MEM-1 (nax review 20260829): everything from crash-handler installation onward is
  // wrapped in this try/catch. runner.ts's own finally (which calls cleanupCrashHandlers()
  // and runtime.close()) only runs once setupRun has RESOLVED — a throw from any setup
  // step (loadPRD, initInteractionChain, the .nax/ auto-migration, sweepOrphans, or
  // anything in the post-lock try below) used to leave SIGTERM/SIGINT/SIGHUP/
  // uncaughtException/unhandledRejection handlers installed and bound to a run that
  // never started, and never closed the runtime (agentManager/sessionManager teardown).
  // In-process consumers (tests, an embedded TUI/watch) then hit stale teardown —
  // pidRegistry.killAll(), process.exit(130) — on a later signal. This replaces the old
  // EXEC-2 site-specific cleanupCrashHandlers() call at the lock-acquisition-failure
  // branch below, which covered only that one throw site.
  // Not definite-assignment-asserted: installCrashHandlers() itself can throw, so the
  // catch below genuinely may run before this is assigned. The optional type is what
  // makes the `cleanupCrashHandlers?.()` call there honest rather than defensive.
  let cleanupCrashHandlers: (() => void) | undefined;
  try {
    // Install crash handlers for signal recovery (US-007, BUG-1+MEM-1 fix: pass getters, cleanup in finally)
    cleanupCrashHandlers = _runSetupDeps.installCrashHandlers({
      statusWriter,
      getTotalCost,
      getIterations,
      jsonlFilePath: logFilePath,
      pidRegistry: runtime.pidRegistry,
      abortController: shutdownController,
      // @design: BUG-017: Pass context for run.complete event on SIGTERM
      runId: options.runId,
      feature: options.feature,
      featureDir: options.featureDir,
      getStartTime: () => options.startTime,
      getTotalStories: options.getTotalStories,
      getStoriesCompleted: options.getStoriesCompleted,
      emitError: (reason: string) => {
        pipelineEventBus.emit({ type: "run:errored", reason, feature: options.feature });
      },
      onShutdown: async (abortSignal?: AbortSignal) => {
        // force=true: signal-driven shutdown must hard-terminate daemons (acpx stop)
        // regardless of session state to prevent orphaned acpx/claude/opencode processes.
        await closeAllRunSessions(sessionManager, options.agentGetFn, { force: true, signal: abortSignal });
        // #2014: drain the run's ledgers on the signal path too. runtime.close()
        // is the only caller of costAggregator.drain() (plus the prompt/review
        // auditor flushes) — without this, a Ctrl+C-terminated run exits with
        // the whole run's spend still in memory: no cost/<runId>.jsonl at all.
        // Sessions close first (the killAll() sweep after performTeardown's
        // onShutdown needs the PIDs those spawns registered); the drain runs
        // last because it only writes buffered JSONL and has no live
        // dependencies. Bounded by FATAL_TEARDOWN_DEADLINE_MS, armed before
        // performTeardown — a wedged drain cannot defeat Ctrl+C.
        // Idempotent: the normal-path finally also calls runtime.close().
        // SIG-1: a failed close here would lose the ledger silently — the
        // swallow stays (the teardown deadline must win over a wedged flush),
        // but the failure becomes auditable.
        await runtime.close().catch((err) => {
          getSafeLogger()?.warn(
            "run-setup",
            "Signal-path runtime close failed — cost/prompt/review ledgers may not have been drained",
            { error: errorMessage(err) },
          );
        });
      },
    });

    // Load PRD (before try block so it's accessible in finally for onRunEnd)
    const prd = await loadPRD(prdPath);

    // Initialize interaction chain (US-008) — do this BEFORE precheck so story size prompts can use it
    const interactionChain = await initInteractionChain(config, headless);

    // ── Prime StatusWriter with PRD so precheck-failed can be recorded ─────────
    statusWriter.setPrd(prd);

    // Auto-migrate generated content out of .nax/ if needed (no-op when already migrated)
    {
      const { detectGeneratedContent, migrateCommand } = await import("@/commands");
      const naxDir = path.join(workdir, ".nax");
      const candidates = await detectGeneratedContent(naxDir).catch(() => []);
      if (candidates.length > 0) {
        logger?.info("setup", "Found generated content under .nax/ — migrating to output dir", {
          storyId: "_setup",
          count: candidates.length,
        });
        try {
          await migrateCommand({ workdir });
          logger?.info("setup", "Auto-migration complete", { storyId: "_setup" });
        } catch (err) {
          logger?.warn("setup", "Auto-migration failed — continuing without migration", {
            storyId: "_setup",
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // Claim project identity on first run (no-op if already claimed for this workdir)
    {
      const { claimProjectIdentity } = await import("@/runtime");
      let remoteUrl: string | null = null;
      try {
        const gitResult = Bun.spawnSync(["git", "remote", "get-url", "origin"], { cwd: workdir, env: gitSpawnEnv() });
        if (gitResult.exitCode === 0) {
          remoteUrl = new TextDecoder().decode(gitResult.stdout).trim() || null;
        }
      } catch {
        /* non-git project — remoteUrl stays null */
      }
      const projectKey = config.name?.trim() || path.basename(workdir);
      await claimProjectIdentity(projectKey, workdir, remoteUrl).catch((err) => {
        if (err instanceof NaxError && err.code === "RUN_NAME_COLLISION") {
          throw err;
        }
        logger?.warn("setup", "Failed to claim project identity", {
          storyId: "_setup",
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    // ── Run precheck validations (unless --skip-precheck) ──────────────────────
    if (!skipPrecheck) {
      const { runPrecheckValidation } = await import("./precheck-runner");
      await runPrecheckValidation({
        config,
        prd,
        workdir,
        logFilePath,
        statusWriter,
        headless,
        formatterMode,
        interactionChain,
        featureName: feature,
      });
    } else {
      logger?.warn("precheck", "Precheck validations skipped (--skip-precheck)");
    }

    // Phase 3 (#477): stale session sweep via sidecar removed.
    // Run-level SessionManager now owns orphan sweeps at startup.
    const sweptOrphans = sessionManager.sweepOrphans();
    if (sweptOrphans > 0) {
      logger?.info("session", "Swept orphan sessions at run setup", { sweptOrphans });
    }

    // Acquire both locks in fixed order — checkout first, then feature — so
    // a partial acquire is always unwound before the error escapes. The
    // checkout lock (project-scoped) keeps two nax processes in the same
    // directory from racing; the feature lock (outputDir-scoped) refuses a
    // second run on the same feature. Both must be held together; either
    // alone leaves a window for unsynchronised mutation.
    const checkoutLock = await _runSetupDeps.acquireLock(workdir);
    if (!checkoutLock.acquired) {
      // `storyId: "_setup"` follows the convention every other log call in
      // this file uses (e.g. the auto-migration call below at line ~313).
      // Replay/reconstruct (src/replay/reconstruct.ts) falls back to
      // `entry.data?.storyId` when the top-level `entry.storyId` is absent,
      // so a missing data.storyId would orphan the refusal from the run's
      // log filter.
      logger?.error("execution", "Another nax process is already running in this directory", {
        storyId: "_setup",
      });
      logger?.error("execution", "If you believe this is an error, remove nax.lock manually", {
        storyId: "_setup",
      });
      // EXEC-2: this throw is caught by the outer try/catch above (MEM-1), whose catch
      // calls cleanupCrashHandlers() and closes the runtime — no site-specific cleanup
      // needed here any more.
      throw new LockAcquisitionError({
        workdir,
        pid: checkoutLock.holder.pid,
        host: checkoutLock.holder.host,
      });
    }

    let featureLock: FeatureLockResult;
    try {
      featureLock = await _runSetupDeps.acquireFeatureLock({
        outputDir: runtime.outputDir,
        feature,
        workdir,
        runId,
      });
    } catch (err) {
      // acquireFeatureLock THREW (mkdir failure, rename EACCES, exclusive
      // create EIO, …) after the checkout lock was already taken. Release
      // the checkout lock before propagating so the directory isn't
      // permanently locked. The refusal branch below is a separate code path
      // (acquireFeatureLock returned `{ acquired: false }` rather than threw).
      await releaseLock(workdir);
      throw err;
    }
    if (!featureLock.acquired) {
      // Feature lock refused: release the checkout lock we just took so
      // the directory isn't permanently locked, then surface the refusal.
      await releaseLock(workdir);
      throw new LockAcquisitionError({
        workdir,
        feature,
        pid: featureLock.holder.pid,
        host: featureLock.holder.host,
        holderWorkdir: featureLock.holder.workdir,
      });
    }

    // Delegate post-lock initialization. `initializeAfterLock` owns its own
    // try/catch that releases both locks in reverse on failure (FIX-H16),
    // so the locks are released before any error escapes this scope.
    const initResult = await initializeAfterLock({
      config,
      workdir,
      feature,
      dryRun,
      runtime,
      prdPath,
      prd,
      interactionChain,
      runId,
      agentGetFn: options.agentGetFn,
      statusWriter,
      deps: {
        detectProjectProfile: _runSetupDeps.detectProjectProfile,
        sweepFeatureTranscripts: _runSetupDeps.sweepFeatureTranscripts,
      },
    });

    return {
      statusWriter,
      sessionManager,
      cleanupCrashHandlers,
      pluginRegistry: initResult.pluginRegistry,
      prd: initResult.prd,
      storyCounts: initResult.storyCounts,
      interactionChain: initResult.interactionChain,
      shutdownController,
      runtime,
    };
  } catch (error) {
    // MEM-1 (nax review 20260829): uninstall crash handlers and close the runtime before
    // propagating — see the rationale comment above the outer try. runtime.close() may
    // itself throw (e.g. a session already mid-teardown); swallow that so it can never
    // mask the original setup failure, which is what the caller needs to see.
    cleanupCrashHandlers?.();
    try {
      await runtime.close();
    } catch (closeError) {
      getSafeLogger()?.warn("run-setup", "runtime.close() failed during setup-failure cleanup", {
        storyId: "_setup",
        error: errorMessage(closeError),
      });
    }
    throw error;
  }
}
