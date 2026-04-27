/**
 * TDD Session Runner
 *
 * Extracted from orchestrator.ts: runTddSession, truncateTestOutput, rollbackToRef
 */

import type { AgentAdapter } from "../agents";
import { resolveDefaultAgent, wrapAdapterAsManager } from "../agents";
import type { ModelTier, NaxConfig } from "../config";
import { resolveModelForAgent } from "../config";
import { createContextToolRuntime } from "../context/engine";
import type { InteractionBridge } from "../interaction/bridge-builder";
import { getLogger } from "../logger";
import type { UserStory } from "../prd";
import { PromptBuilder } from "../prompts";
import type { ISessionManager } from "../session/types";
import { autoCommitIfDirty as _autoCommitIfDirtyFn } from "../utils/git";
import { captureGitRef as _captureGitRef } from "../utils/git";
import { cleanupProcessTree as _cleanupProcessTree } from "./cleanup";
/**
 * Injectable dependencies for session-runner — allows tests to mock
 * autoCommitIfDirty without going through internal git deps.
 * @internal
 */
import {
  getChangedFiles as _getChangedFiles,
  verifyImplementerIsolation as _verifyImplementerIsolation,
  verifyTestWriterIsolation as _verifyTestWriterIsolation,
} from "./isolation";

export const _sessionRunnerDeps = {
  autoCommitIfDirty: _autoCommitIfDirtyFn,
  spawn: Bun.spawn as typeof Bun.spawn,
  getChangedFiles: _getChangedFiles,
  verifyTestWriterIsolation: _verifyTestWriterIsolation,
  verifyImplementerIsolation: _verifyImplementerIsolation,
  captureGitRef: _captureGitRef,
  cleanupProcessTree: _cleanupProcessTree,
  buildPrompt: null as
    | null
    | ((
        role: TddSessionRole,
        config: NaxConfig,
        story: UserStory,
        workdir: string,
        contextMarkdown?: string,
        lite?: boolean,
        constitution?: string,
        featureContextMarkdown?: string,
      ) => Promise<string>),
};
import type { IsolationCheck } from "./types";
import type { TddSessionResult, TddSessionRole } from "./types";

/**
 * Truncate test output to prevent context flooding.
 * Keeps first 10 lines and last 40 lines with a separator.
 */
export function truncateTestOutput(output: string, maxLines = 50): string {
  const lines = output.split("\n");
  if (lines.length <= maxLines) {
    return output;
  }

  const headLines = 10;
  const tailLines = 40;
  const head = lines.slice(0, headLines).join("\n");
  const tail = lines.slice(-tailLines).join("\n");
  const truncatedCount = lines.length - headLines - tailLines;

  return `${head}\n\n... (${truncatedCount} lines truncated) ...\n\n${tail}`;
}

/**
 * Rollback git changes to a specific ref.
 * Used when TDD fails to revert uncommitted/committed changes.
 */
export async function rollbackToRef(workdir: string, ref: string): Promise<void> {
  const logger = getLogger();
  logger.warn("tdd", "Rolling back git changes", { ref });

  const resetProc = _sessionRunnerDeps.spawn(["git", "reset", "--hard", ref], {
    cwd: workdir,
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = await resetProc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(resetProc.stderr).text();
    logger.error("tdd", "Failed to rollback git changes", { ref, stderr });
    throw new Error(`Git rollback failed: ${stderr}`);
  }

  const cleanProc = _sessionRunnerDeps.spawn(["git", "clean", "-fd"], {
    cwd: workdir,
    stdout: "pipe",
    stderr: "pipe",
  });

  const cleanExitCode = await cleanProc.exited;
  if (cleanExitCode !== 0) {
    const stderr = await new Response(cleanProc.stderr).text();
    logger.warn("tdd", "Failed to clean untracked files", { stderr });
  }

  logger.info("tdd", "Successfully rolled back git changes", { ref });
}

/**
 * Binding used to tie a TDD session's ACP protocolIds back to a pre-created
 * session descriptor so the audit trail includes recordId/sessionId (#541).
 * ADR-013 Phase 1: agentManager added so runTddSession can go through
 * the shared IAgentManager surface instead of calling adapter primitives directly.
 */
export interface TddSessionBinding {
  sessionManager: ISessionManager;
  sessionId: string;
  /** When provided, routes the session through IAgentManager.run() for fallback support. */
  agentManager?: import("../agents/manager-types").IAgentManager;
}

/** Run a single TDD session */
export async function runTddSession(
  role: TddSessionRole,
  agent: AgentAdapter,
  story: UserStory,
  config: NaxConfig,
  workdir: string,
  modelTier: ModelTier,
  beforeRef: string,
  contextMarkdown?: string,
  lite = false,
  skipIsolation = false,
  constitution?: string,
  featureName?: string,
  interactionBridge?: InteractionBridge,
  projectDir?: string,
  featureContextMarkdown?: string,
  contextBundle?: import("../context/engine").ContextBundle,
  sessionBinding?: TddSessionBinding,
  abortSignal?: AbortSignal,
): Promise<TddSessionResult> {
  const startTime = Date.now();

  // Build prompt — use injectable buildPrompt if set, otherwise default PromptBuilder.
  // When a v2 ContextBundle is available, .v2FeatureContext() injects pushMarkdown directly
  // (bypasses filterContextByRole which drops ##-section content).  featureContextMarkdown
  // is used as the v1 fallback via .featureContext() when no bundle is present.
  let prompt: string;
  if (_sessionRunnerDeps.buildPrompt) {
    const effectiveFeatureCtx = contextBundle ? contextBundle.pushMarkdown : featureContextMarkdown;
    prompt = await _sessionRunnerDeps.buildPrompt(
      role,
      config,
      story,
      workdir,
      contextMarkdown,
      lite,
      constitution,
      effectiveFeatureCtx,
    );
  } else {
    switch (role) {
      case "test-writer":
        prompt = await PromptBuilder.for("test-writer", { isolation: lite ? "lite" : "strict" })
          .withLoader(workdir, config)
          .story(story)
          .context(contextMarkdown)
          .v2FeatureContext(contextBundle?.pushMarkdown)
          .featureContext(contextBundle ? undefined : featureContextMarkdown)
          .constitution(constitution)
          .testCommand(config.quality?.commands?.test)
          .hermeticConfig(config.quality?.testing)
          .build();
        break;
      case "implementer":
        prompt = await PromptBuilder.for("implementer", { variant: lite ? "lite" : "standard" })
          .withLoader(workdir, config)
          .story(story)
          .context(contextMarkdown)
          .v2FeatureContext(contextBundle?.pushMarkdown)
          .featureContext(contextBundle ? undefined : featureContextMarkdown)
          .constitution(constitution)
          .testCommand(config.quality?.commands?.test)
          .hermeticConfig(config.quality?.testing)
          .build();
        break;
      case "verifier":
        prompt = await PromptBuilder.for("verifier")
          .withLoader(workdir, config)
          .story(story)
          .context(contextMarkdown)
          .v2FeatureContext(contextBundle?.pushMarkdown)
          .featureContext(contextBundle ? undefined : featureContextMarkdown)
          .constitution(constitution)
          .testCommand(config.quality?.commands?.test)
          .hermeticConfig(config.quality?.testing)
          .build();
        break;
    }
  }

  const logger = getLogger();
  logger.info("tdd", `-> Session: ${role}`, { role, storyId: story.id, lite });

  // When rectification is enabled, keep the implementer session open after it finishes.
  // Legacy path: the rectification gate resumes the same session directly, preserving context.
  // ADR-019 runtime path: each rectification hop opens a fresh session via buildHopCallback;
  // keepOpen=true causes session-run-hop to skip closeSession so the sweep handles cleanup.
  // This flag lives in runOptions and is meaningful regardless of execution path (ADR-019 Phase D).
  const keepOpen = role === "implementer" && (config.execution.rectification?.enabled ?? false);

  const agentRunOptions = {
    prompt,
    workdir,
    modelTier,
    modelDef: resolveModelForAgent(
      config.models,
      story.routing?.agent ?? resolveDefaultAgent(config),
      modelTier,
      resolveDefaultAgent(config),
    ),
    timeoutSeconds: config.execution.sessionTimeoutSeconds,
    pipelineStage: "run" as const,
    config,
    projectDir,
    maxInteractionTurns: config.agent?.maxInteractionTurns,
    featureName,
    storyId: story.id,
    sessionRole: role,
    keepOpen,
    contextPullTools: contextBundle?.pullTools,
    contextToolRuntime: contextBundle
      ? createContextToolRuntime({
          bundle: contextBundle,
          story,
          config,
          repoRoot: workdir,
        })
      : undefined,
    interactionBridge,
    abortSignal,
  };

  // Run the agent. When a sessionBinding is provided, route through
  // SessionManager.runInSession so state transitions (CREATED → RUNNING →
  // COMPLETED/FAILED) and bindHandle happen automatically (#541, #589).
  // ADR-013 Phase 1: runInSession now takes IAgentManager. Use the binding's
  // agentManager when present; otherwise wrap adapter for a no-fallback path.
  // Absent binding path stays compatible with tests that skip SessionManager.
  const effectiveManager: import("../agents/manager-types").IAgentManager =
    sessionBinding?.agentManager ?? wrapAdapterAsManager(agent);

  const result = sessionBinding
    ? await sessionBinding.sessionManager.runInSession(sessionBinding.sessionId, effectiveManager, {
        runOptions: agentRunOptions,
        signal: agentRunOptions.abortSignal,
      })
    : await effectiveManager.run({ runOptions: agentRunOptions });

  // When binding is present, runInSession already persisted protocolIds
  // using the descriptor's handle. If the descriptor had no handle (race on
  // first use), re-bind now with the agent's derived session name so later
  // resume logic can find the ACP record.
  if (sessionBinding && result.protocolIds) {
    const descriptor = sessionBinding.sessionManager.get(sessionBinding.sessionId);
    if (descriptor && !descriptor.handle) {
      sessionBinding.sessionManager.bindHandle(
        sessionBinding.sessionId,
        sessionBinding.sessionManager.nameFor({
          workdir: descriptor.workdir,
          featureName: descriptor.featureName,
          storyId: descriptor.storyId,
          role: descriptor.role,
        }),
        result.protocolIds,
      );
    }
  }

  // BUG-21 Fix: Clean up orphaned child processes if agent failed
  if (!result.success && result.pid) {
    await _sessionRunnerDeps.cleanupProcessTree(result.pid);
  }

  if (result.success) {
    logger.info("tdd", `Session complete: ${role}`, {
      role,
      storyId: story.id,
      durationMs: Date.now() - startTime,
      cost: result.estimatedCostUsd,
    });
  } else {
    logger.warn("tdd", `Session failed: ${role}`, {
      role,
      storyId: story.id,
      durationMs: Date.now() - startTime,
      exitCode: result.exitCode,
      ...(result.output ? { output: result.output.slice(0, 500) } : {}),
    });
  }

  // BUG-058: Auto-commit if agent left uncommitted changes
  await _sessionRunnerDeps.autoCommitIfDirty(workdir, "tdd", role, story.id);

  // Check isolation based on role and skipIsolation flag.
  let isolation: IsolationCheck | undefined;
  if (!skipIsolation) {
    // ADR-009: pass undefined when user hasn't configured patterns → broad regex fallback in isTestFile.
    const testFilePatterns =
      typeof config.execution?.smartTestRunner === "object"
        ? config.execution.smartTestRunner?.testFilePatterns
        : undefined;
    if (role === "test-writer") {
      const allowedPaths = config.tdd.testWriterAllowedPaths ?? ["src/index.ts", "src/**/index.ts"];
      isolation = await _sessionRunnerDeps.verifyTestWriterIsolation(
        workdir,
        beforeRef,
        allowedPaths,
        testFilePatterns,
      );
    } else if (role === "implementer" || role === "verifier") {
      isolation = await _sessionRunnerDeps.verifyImplementerIsolation(workdir, beforeRef, testFilePatterns);
    }
  }

  // Get changed files
  const filesChanged = await _sessionRunnerDeps.getChangedFiles(workdir, beforeRef);

  const durationMs = Date.now() - startTime;

  if (isolation && !isolation.passed) {
    logger.error("tdd", "Isolation violated", {
      role,
      storyId: story.id,
      description: isolation.description,
      violations: isolation.violations,
    });
  } else if (isolation) {
    if (isolation.softViolations && isolation.softViolations.length > 0) {
      logger.warn("tdd", "[WARN] Isolation soft violations (allowed files modified)", {
        role,
        storyId: story.id,
        softViolations: isolation.softViolations,
      });
    }
    if (isolation.warnings && isolation.warnings.length > 0) {
      logger.warn("tdd", "[WARN] Isolation maintained with warnings", {
        role,
        storyId: story.id,
        warnings: isolation.warnings,
      });
    }
    if (!isolation.softViolations?.length && !isolation.warnings?.length) {
      logger.info("tdd", "Isolation maintained", { role, storyId: story.id });
    }
  }

  return {
    role,
    success: result.success && (!isolation || isolation.passed),
    isolation,
    filesChanged,
    durationMs,
    estimatedCostUsd: result.estimatedCostUsd,
    tokenUsage: result.tokenUsage,
    outputTail: result.output.slice(-500),
  };
}
