/**
 * Run Setup — Post-Lock Initialization
 *
 * Owns the body of work that runs after `acquireLock` succeeds in setupRun.
 * Extracted from run-setup.ts (which was at the 600-line hard cap) so the
 * orchestrator stays focused on wiring and lock acquisition.
 *
 * Responsibilities (run in this order, all under the held lock):
 *   1. Sweep retained feature transcripts (US-002 AC10/AC11)
 *   2. Wipe scratchpad + reconcile .gitignore (US-004)
 *   3. Detect project profile (US-003) and log explicit vs auto-detected values
 *   4. Load plugins
 *   5. Log the run-start banner
 *   6. initializeRun() — agent install check, state reconciliation, story count gate
 *   7. warnProfileMismatch — re-validate story agentProfileId references
 *   8. Prompt for paused stories (skip in headless mode)
 *
 * The inner try/catch that owns `releaseLock` lives here too (FIX-H16): if any
 * step throws, the lock is released before re-raising. setupRun's outer
 * try/catch (MEM-1) handles crash-handler + runtime.close cleanup and runs
 * AFTER this helper's catch has released the lock.
 *
 * Deps injection: takes `deps` as a parameter so setupRun can thread
 * `_runSetupDeps.detectProjectProfile` / `sweepFeatureTranscripts` through at
 * call time without creating an import cycle.
 */

import path from "node:path";
import { globalConfigDir, type NaxConfig } from "@/config";
import type { InteractionChain } from "@/interaction";
import { getSafeLogger } from "@/logger";
import type { AgentGetFn } from "@/pipeline/types";
import { loadPlugins } from "@/plugins";
import type { PluginRegistry } from "@/plugins/registry";
import { countStories, type PRD, savePRD } from "@/prd";
import type { detectProjectProfile } from "@/project";
import type { NaxRuntime } from "@/runtime";
import type { sweepFeatureTranscripts } from "@/session";
import { resolveTestFilePatterns } from "@/test-runners";
import { NAX_BUILD_INFO, NAX_COMMIT, NAX_VERSION } from "@/version";
import { releaseLock } from "../helpers";
import type { StatusWriter } from "../status-writer";
import { warnProfileMismatch } from "./run-setup-warnings";
import { wipeScratchpad } from "./scratchpad-wipe";

/**
 * Slice of `_runSetupDeps` that this helper reads. Threaded as a parameter so
 * `run-setup-init.ts` doesn't need to import from `run-setup.ts` (would cycle).
 * The structural type means callers don't have to import `_runSetupDeps`.
 */
export interface InitializeAfterLockDeps {
  detectProjectProfile: typeof detectProjectProfile;
  sweepFeatureTranscripts: typeof sweepFeatureTranscripts;
}

export interface InitializeAfterLockOptions {
  config: NaxConfig;
  workdir: string;
  feature: string;
  dryRun: boolean;
  runtime: NaxRuntime;
  prdPath: string;
  prd: PRD;
  interactionChain: InteractionChain | null;
  runId: string;
  agentGetFn?: AgentGetFn;
  /** StatusWriter — passed in so crash handlers during the prompt window see current state (#356). */
  statusWriter: StatusWriter;
  deps: InitializeAfterLockDeps;
}

export interface InitializeAfterLockResult {
  pluginRegistry: PluginRegistry;
  prd: PRD;
  storyCounts: {
    total: number;
    passed: number;
    pending: number;
    failed: number;
    paused: number;
    skipped: number;
    blocked: number;
  };
  interactionChain: InteractionChain | null;
}

/**
 * Execute post-lock initialization. Releases the run lock on failure before
 * re-raising (FIX-H16).
 */
export async function initializeAfterLock(options: InitializeAfterLockOptions): Promise<InitializeAfterLockResult> {
  const logger = getSafeLogger();
  const { config, workdir, feature, dryRun, runtime, interactionChain, runId, agentGetFn, statusWriter, deps } =
    options;

  // Everything after lock acquisition is wrapped in try-catch to ensure
  // the lock is released if any setup step fails (FIX-H16)
  try {
    // US-002 AC10/AC11: prune retained transcripts only after the run lock
    // prevents concurrent setup from racing over the same files.
    const sweptTranscripts = await deps.sweepFeatureTranscripts({
      featureName: feature,
      transcriptRoot: runtime.outputDir,
      dryRun,
    });
    if (sweptTranscripts > 0) {
      logger?.info("session", "Swept retained transcripts at run setup", { sweptTranscripts });
    }

    // ── Scratchpad wipe (US-004) ────────────────────────────────────────────
    // The scratchpad tools (US-002) advertise throwaway storage wiped at the
    // start of each run, so anything an agent parked last run is cleared
    // before this one writes. Behind the same lock as the sweep above: the
    // wipe is destructive run state, and a second nax process that loses the
    // lock race must not clear the running run's scratchpad on its way out.
    // Unlike the sweep it is also gated on dryRun, for the same reason the
    // sweep is: a preview must not mutate the tree. Absence and failure are
    // tolerated inside wipeScratchpad() — a busy handle or a permission error
    // must never wedge a run.
    await wipeScratchpad(workdir, { dryRun });
    await (await import("./gitignore-reconcile")).reconcileMainGitignore(workdir, { dryRun });

    // ── Detect project profile (US-003) and log explicit vs auto-detected values ──
    const existingProjectConfig = config.project ?? {};
    const detectedProfile = await deps.detectProjectProfile(workdir, existingProjectConfig);
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
          ? `detected: ${autodetectedFields.map((field) => `${field}=${String(detectedProfile[field])}`).join(", ")}`
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
    const effectiveAgentGetFn = agentGetFn ?? runtime.agentManager.getAgent.bind(runtime.agentManager);
    const { initializeRun } = await import("./run-initialization");
    const initResult = await initializeRun({
      config,
      prdPath: options.prdPath,
      workdir,
      dryRun,
      agentGetFn: effectiveAgentGetFn,
    });
    const prd = initResult.prd;
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
        await savePRD(prd, options.prdPath);
        counts = countStories(prd);
      }
    }

    return {
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
