/**
 * Run Setup — Initial Setup Logic
 *
 * Handles the initial setup phase before the main execution loop:
 * - Status writer initialization
 * - PID registry cleanup
 * - Crash handler installation
 * - Lock acquisition
 * - Plugin loading
 * - PRD loading
 * - Precheck validation
 * - Run initialization
 */

import * as os from "node:os";
import path from "node:path";
import type { NaxConfig } from "../../config";
import { LockAcquisitionError } from "../../errors";
import type { LoadedHooksConfig } from "../../hooks";
import type { InteractionChain } from "../../interaction";
import { initInteractionChain } from "../../interaction";
import { getSafeLogger } from "../../logger";
import { pipelineEventBus } from "../../pipeline/event-bus";
import type { AgentGetFn } from "../../pipeline/types";
import { loadPlugins } from "../../plugins/loader";
import type { PluginRegistry } from "../../plugins/registry";
import type { PRD } from "../../prd";
import { countStories, loadPRD, savePRD } from "../../prd";
import { detectProjectProfile } from "../../project";
import { NAX_BUILD_INFO, NAX_COMMIT, NAX_VERSION } from "../../version";
import { installCrashHandlers } from "../crash-recovery";
import { acquireLock, releaseLock } from "../helpers";
import { PidRegistry } from "../pid-registry";
import { StatusWriter } from "../status-writer";

/** Injectable deps for run-setup (enables testing without heavy side-effects) */
export const _runSetupDeps = {
  detectProjectProfile,
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
  // BUG-017: Additional getters for run.complete event on SIGTERM
  getStoriesCompleted: () => number;
  getTotalStories: () => number;
  /** Protocol-aware agent resolver — passed from runner.ts registry */
  agentGetFn?: AgentGetFn;
}

export interface RunSetupResult {
  statusWriter: StatusWriter;
  pidRegistry: PidRegistry;
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
}

/**
 * Execute initial setup phase
 */
export async function setupRun(options: RunSetupOptions): Promise<RunSetupResult> {
  const logger = getSafeLogger();
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

  // ── Status writer (encapsulates status file state and write logic) ───────
  const statusWriter = new StatusWriter(statusFile, config, {
    runId,
    feature,
    startedAt,
    dryRun,
    startTimeMs: startTime,
    pid: process.pid,
  });

  // ── PID registry for orphan process cleanup (BUG-002) ───────
  const pidRegistry = new PidRegistry(workdir);

  // Cleanup stale PIDs from previous crashed runs
  await pidRegistry.cleanupStale();

  // Install crash handlers for signal recovery (US-007, BUG-1+MEM-1 fix: pass getters, cleanup in finally)
  const cleanupCrashHandlers = installCrashHandlers({
    statusWriter,
    getTotalCost,
    getIterations,
    jsonlFilePath: logFilePath,
    pidRegistry,
    // BUG-017: Pass context for run.complete event on SIGTERM
    runId: options.runId,
    feature: options.feature,
    featureDir: options.featureDir,
    getStartTime: () => options.startTime,
    getTotalStories: options.getTotalStories,
    getStoriesCompleted: options.getStoriesCompleted,
    emitError: (reason: string) => {
      pipelineEventBus.emit({ type: "run:errored", reason, feature: options.feature });
    },
    // Close open ACP sessions on SIGINT/SIGTERM so acpx processes don't stay alive
    onShutdown: async () => {
      const { sweepFeatureSessions } = await import("../../agents/acp/adapter");
      await sweepFeatureSessions(workdir, feature, pidRegistry).catch(() => {});
    },
  });

  // Load PRD (before try block so it's accessible in finally for onRunEnd)
  let prd = await loadPRD(prdPath);

  // Initialize interaction chain (US-008) — do this BEFORE precheck so story size prompts can use it
  const interactionChain = await initInteractionChain(config, headless);

  // ── Prime StatusWriter with PRD so precheck-failed can be recorded ─────────
  statusWriter.setPrd(prd);

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

  // Sweep stale ACP sessions from previous crashed runs (safety net)
  const { sweepStaleFeatureSessions } = await import("../../agents/acp/adapter");
  await sweepStaleFeatureSessions(workdir, feature, undefined, pidRegistry).catch(() => {});

  // Acquire lock to prevent concurrent execution
  const lockAcquired = await acquireLock(workdir);
  if (!lockAcquired) {
    logger?.error("execution", "Another nax process is already running in this directory");
    logger?.error("execution", "If you believe this is an error, remove nax.lock manually");
    throw new LockAcquisitionError(workdir);
  }

  // Everything after lock acquisition is wrapped in try-catch to ensure
  // the lock is released if any setup step fails (FIX-H16)
  try {
    // ── Detect project profile (US-003) and log explicit vs auto-detected values ──
    const existingProjectConfig = config.project ?? {};
    const detectedProfile = await _runSetupDeps.detectProjectProfile(workdir, existingProjectConfig);
    config.project = detectedProfile;

    // Distinguish explicit config from auto-detected values (AC-4)
    const explicitFields = Object.keys(existingProjectConfig) as Array<keyof typeof existingProjectConfig>;
    const autodetectedFields = Object.keys(detectedProfile).filter(
      (key) => !explicitFields.includes(key as keyof typeof existingProjectConfig),
    ) as Array<keyof typeof detectedProfile>;

    let projectLogMessage = "";
    if (explicitFields.length > 0) {
      const explicitValues = explicitFields.map((field) => `${field}=${existingProjectConfig[field]}`).join(", ");
      const detectedValues =
        autodetectedFields.length > 0
          ? `detected: ${autodetectedFields.map((field) => `${field}=${detectedProfile[field]}`).join(", ")}`
          : "";
      projectLogMessage = `Using explicit config: ${explicitValues}${detectedValues ? `; ${detectedValues}` : ""}`;
    } else {
      projectLogMessage = `Detected: ${detectedProfile.language ?? "unknown"}/${detectedProfile.type ?? "unknown"} (${detectedProfile.testFramework ?? "none"}, ${detectedProfile.lintTool ?? "none"})`;
    }
    logger?.info("project", projectLogMessage, {
      explicit: Object.fromEntries(explicitFields.map((f) => [f, existingProjectConfig[f]])),
      detected: Object.fromEntries(autodetectedFields.map((f) => [f, detectedProfile[f]])),
    });

    // Load plugins (before try block so it's accessible in finally)
    const globalPluginsDir = path.join(os.homedir(), ".nax", "plugins");
    const projectPluginsDir = path.join(workdir, ".nax", "plugins");
    const configPlugins = config.plugins || [];
    const pluginRegistry = await loadPlugins(
      globalPluginsDir,
      projectPluginsDir,
      configPlugins,
      workdir,
      config.disabledPlugins,
    );

    // Log plugins loaded
    logger?.info("plugins", `Loaded ${pluginRegistry.plugins.length} plugins`, {
      plugins: pluginRegistry.plugins.map((p) => ({ name: p.name, version: p.version, provides: p.provides })),
    });

    // Log run start
    const routingMode = config.routing.llm?.mode ?? "hybrid";
    logger?.info("run.start", `Starting feature: ${feature} [nax ${NAX_BUILD_INFO}]`, {
      runId,
      feature,
      workdir,
      dryRun,
      routingMode,
      naxVersion: NAX_VERSION,
      naxCommit: NAX_COMMIT,
    });

    // on-start hook is now fired by the hooks.ts subscriber via the run:started event
    // emitted inside executeUnified/executeSequential after bus wiring.

    // Initialize run: check agent, reconcile state, validate limits
    const { initializeRun } = await import("./run-initialization");
    const initResult = await initializeRun({
      config,
      prdPath,
      workdir,
      dryRun,
      agentGetFn: options.agentGetFn,
    });
    prd = initResult.prd;
    // initializeRun calls loadPRD() internally, producing a new object.
    // Re-prime statusWriter so crash handlers during the prompt window see current state (#356).
    statusWriter.setPrd(prd);
    let counts = initResult.storyCounts;

    // Prompt user for each paused story — skip in headless mode
    if (counts.paused > 0 && interactionChain !== null) {
      const { promptForPausedStories } = await import("./paused-story-prompts");
      const pausedSummary = await promptForPausedStories(
        prd,
        interactionChain,
        feature,
        config.execution.storyIsolation,
      );
      if (pausedSummary.resumed.length > 0 || pausedSummary.skipped.length > 0) {
        await savePRD(prd, prdPath);
        counts = countStories(prd);
      }
    }

    return {
      statusWriter,
      pidRegistry,
      cleanupCrashHandlers,
      pluginRegistry,
      prd,
      storyCounts: counts,
      interactionChain,
    };
  } catch (error) {
    // Release lock before re-throwing so the directory isn't permanently locked
    await releaseLock(workdir);
    throw error;
  }
}
