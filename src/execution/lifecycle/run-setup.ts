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

import path from "node:path";
import { globalConfigDir, type NaxConfig } from "@/config";
import { LockAcquisitionError, NaxError } from "@/errors";
import type { LoadedHooksConfig } from "@/hooks";
import type { InteractionChain } from "@/interaction";
import { initInteractionChain } from "@/interaction";
import { getSafeLogger } from "@/logger";
import { pipelineEventBus } from "@/pipeline";
import type { AgentGetFn } from "@/pipeline/types";
import { loadPlugins } from "@/plugins";
import type { PluginRegistry } from "@/plugins/registry";
import type { PRD } from "@/prd";
import { countStories, loadPRD, savePRD } from "@/prd";
import { detectProjectProfile } from "@/project";
import { createRuntime, type NaxRuntime } from "@/runtime";
import { SessionManager } from "@/session";
import { discoverWorkspacePackages, resolveTestFilePatterns } from "@/test-runners";
import { errorMessage } from "@/utils/errors";
import { NAX_BUILD_INFO, NAX_COMMIT, NAX_VERSION } from "@/version";
import { installCrashHandlers } from "../crash-recovery";
import { acquireLock, releaseLock } from "../helpers";
import { closeAllRunSessions } from "../session-manager-runtime";
import { StatusWriter } from "../status-writer";

/** Injectable deps for run-setup (enables testing without heavy side-effects) */
export const _runSetupDeps = {
  detectProjectProfile,
};

/**
 * Emit a warning for each story whose agentProfileId no longer exists in
 * config.routing.agents.profiles (Task 10 Part B — profile-mismatch check).
 *
 * This handles the case where a user runs an old PRD after removing a profile
 * from config. The existing routing.agent assignment is retained — warn only,
 * no throw.
 */
export function warnProfileMismatch(
  prd: import("@/prd").PRD,
  config: NaxConfig,
  logger: ReturnType<typeof getSafeLogger>,
): void {
  const profiles = config.routing?.agents?.profiles ?? [];
  const profileIds = new Set(profiles.map((p) => p.id));

  // PRD-level check (Delta C4): warn when the run resolves a different config
  // profile than the one the PRD was planned with — the escalation ladder and
  // agent-profile registry may differ from what plan assumed.
  if (prd.routingProfile !== undefined) {
    const current = config.profile ?? "default";
    if (prd.routingProfile !== current) {
      logger?.warn(
        "prd",
        `PRD was planned with config profile "${prd.routingProfile}" but this run resolved profile "${current}" — the escalation ladder and agent profiles may differ from what plan assumed. Re-run with --profile ${prd.routingProfile} to match.`,
        { storyId: "prd", plannedProfile: prd.routingProfile, currentProfile: current },
      );
    }
  }

  const knownAgents = new Set(Object.keys(config.models ?? {}));

  for (const story of prd.userStories) {
    const profileId = story.routing?.agentProfileId;
    if (profileId && !profileIds.has(profileId)) {
      logger?.warn(
        "setup",
        `Story ${story.id} was planned with profile ${profileId} which no longer exists in config — routing.agent assignment retained`,
        { storyId: story.id, agentProfileId: profileId },
      );
    }
    const storyAgent = story.routing?.agent;
    if (storyAgent && !knownAgents.has(storyAgent)) {
      logger?.warn(
        "setup",
        `Story ${story.id} routes to agent "${storyAgent}" which is not defined in config.models — execution will degrade to the default agent`,
        { storyId: story.id, agent: storyAgent },
      );
    }
  }
}

/**
 * Emit a warning for each fallback candidate in config.agent.fallback.map
 * that cannot be resolved by agentGetFn (AC-35 pre-flight check).
 *
 * Deduplicates warnings so each unconfigured candidate is reported once even
 * if it appears under multiple primary agents.
 */
export function warnFallbackMisconfiguration(
  config: NaxConfig,
  agentGetFn: ((name: string) => unknown) | undefined,
  logger: ReturnType<typeof getSafeLogger>,
): void {
  if (!agentGetFn) return;
  const fallback = config.agent?.fallback;
  if (!fallback?.enabled || !fallback.map) return;

  const warned = new Set<string>();
  for (const [primaryAgent, candidates] of Object.entries(fallback.map)) {
    for (const candidate of candidates) {
      if (warned.has(candidate)) continue;
      if (!agentGetFn(candidate)) {
        logger?.warn("fallback", "Fallback candidate not available — will be skipped if triggered", {
          storyId: "_setup",
          primaryAgent,
          candidate,
        });
        warned.add(candidate);
      }
    }
  }
}

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
 * Execute initial setup phase
 */
export async function setupRun(options: RunSetupOptions): Promise<RunSetupResult> {
  const logger = getSafeLogger();

  // AC-35: pre-flight warning for unconfigured fallback candidates
  warnFallbackMisconfiguration(options.config, options.agentGetFn, logger);

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

  // ── Status writer (encapsulates status file state and write logic) ───────
  const statusWriter = new StatusWriter(statusFile, config, {
    runId,
    feature,
    startedAt,
    dryRun,
    startTimeMs: startTime,
    pid: process.pid,
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
  const runtime = createRuntime(config, workdir, {
    parentSignal: shutdownController.signal,
    sessionManager,
    agentManager: options.agentManager,
    featureName: options.feature,
    agentStreamEvents: options.agentStreamEvents,
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

  // Install crash handlers for signal recovery (US-007, BUG-1+MEM-1 fix: pass getters, cleanup in finally)
  const cleanupCrashHandlers = installCrashHandlers({
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
    onShutdown: async () => {
      // force=true: signal-driven shutdown must hard-terminate daemons (acpx stop)
      // regardless of session state to prevent orphaned acpx/claude/opencode processes.
      await closeAllRunSessions(sessionManager, options.agentGetFn, { force: true });
    },
  });

  // Load PRD (before try block so it's accessible in finally for onRunEnd)
  let prd = await loadPRD(prdPath);

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
      const gitResult = Bun.spawnSync(["git", "remote", "get-url", "origin"], { cwd: workdir });
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

  // Acquire lock to prevent concurrent execution
  const lockAcquired = await acquireLock(workdir);
  if (!lockAcquired) {
    logger?.error("execution", "Another nax process is already running in this directory");
    logger?.error("execution", "If you believe this is an error, remove nax.lock manually");
    // EXEC-2: installCrashHandlers ran above, before lock acquisition. This
    // throw is outside the try/finally below (whose finally calls
    // cleanupCrashHandlers), so without this call the SIGTERM/SIGINT/
    // uncaughtException handlers stay installed — bound to a StatusWriter
    // for a run that never started — for the lifetime of the process (e.g.
    // in-process consumers like tests or an embedded TUI).
    cleanupCrashHandlers();
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
    const globalPluginsDir = path.join(globalConfigDir(), "plugins");
    const projectPluginsDir = path.join(workdir, ".nax", "plugins");
    const configPlugins = config.plugins || [];
    // Build a test-file classifier from resolved patterns so the plugin loader
    // honours custom testFilePatterns (ADR-009) instead of hardcoded TS suffixes.
    const resolvedPatterns = await resolveTestFilePatterns(config, workdir);
    const isTestFileFn = (filename: string): boolean => resolvedPatterns.regex.some((re) => re.test(filename));
    const pluginRegistry = await loadPlugins(
      globalPluginsDir,
      projectPluginsDir,
      configPlugins,
      workdir,
      config.disabledPlugins,
      isTestFileFn,
      config.reporters,
    );

    // The LLM routing cache is run-scoped (runtime.routingCache, BUG-19) and
    // already starts empty for this run — no explicit clear needed here.

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
    // Fall back to runtime.agentManager.getAgent when no explicit agentGetFn is
    // provided (runner.ts derives agentGetFn from runtime only after setupRun returns).
    const effectiveAgentGetFn = options.agentGetFn ?? runtime.agentManager.getAgent.bind(runtime.agentManager);
    const { initializeRun } = await import("./run-initialization");
    const initResult = await initializeRun({
      config,
      prdPath,
      workdir,
      dryRun,
      agentGetFn: effectiveAgentGetFn,
    });
    prd = initResult.prd;
    // initializeRun calls loadPRD() internally, producing a new object.
    // Re-prime statusWriter so crash handlers during the prompt window see current state (#356).
    statusWriter.setPrd(prd);

    // Warn when any story was planned with an agent profile that has since been removed.
    warnProfileMismatch(prd, config, logger);

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
      sessionManager,
      cleanupCrashHandlers,
      pluginRegistry,
      prd,
      storyCounts: counts,
      interactionChain,
      shutdownController,
      runtime,
    };
  } catch (error) {
    // Release lock before re-throwing so the directory isn't permanently locked
    await releaseLock(workdir);
    throw error;
  }
}
