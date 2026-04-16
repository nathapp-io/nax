/**
 * TDD Session Runner
 *
 * Extracted from orchestrator.ts: runTddSession, truncateTestOutput, rollbackToRef
 */

import type { AgentAdapter } from "../agents";
import type { ModelTier, NaxConfig } from "../config";
import { resolveModelForAgent } from "../config";
import { resolvePermissions } from "../config/permissions";
import type { InteractionBridge } from "../interaction/bridge-builder";
import { getLogger } from "../logger";
import type { UserStory } from "../prd";
import { PromptBuilder } from "../prompts";
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
import { buildSessionName } from "../agents/acp/adapter";
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
  // The rectification gate uses the same session name and will resume it directly — so
  // the implementer retains full context of what it built.
  // The session sweep (or the last rectification attempt) handles final cleanup.
  const keepSessionOpen = role === "implementer" && (config.execution.rectification?.enabled ?? false);

  // Pin the implementer to an explicit session name derived from the same formula used by
  // rectification-gate.ts. Without this, the adapter falls through to the sidecar which may
  // return a stale name from a prior run, causing the implementer to resume the wrong session
  // and breaking session continuity with the TDD gate and autofix. (ADR-008)
  const acpSessionName =
    role === "implementer" && featureName ? buildSessionName(workdir, featureName, story.id, "implementer") : undefined;

  // Run the agent
  const result = await agent.run({
    prompt,
    workdir,
    modelTier,
    modelDef: resolveModelForAgent(
      config.models,
      story.routing?.agent ?? config.autoMode.defaultAgent,
      modelTier,
      config.autoMode.defaultAgent,
    ),
    timeoutSeconds: config.execution.sessionTimeoutSeconds,
    dangerouslySkipPermissions: resolvePermissions(config, "run").skipPermissions,
    pipelineStage: "run",
    config,
    projectDir,
    maxInteractionTurns: config.agent?.maxInteractionTurns,
    featureName,
    storyId: story.id,
    sessionRole: role,
    acpSessionName,
    keepSessionOpen,
    interactionBridge,
  });

  // BUG-21 Fix: Clean up orphaned child processes if agent failed
  if (!result.success && result.pid) {
    await _sessionRunnerDeps.cleanupProcessTree(result.pid);
  }

  if (result.success) {
    logger.info("tdd", `Session complete: ${role}`, {
      role,
      storyId: story.id,
      durationMs: Date.now() - startTime,
      cost: result.estimatedCost,
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
    estimatedCost: result.estimatedCost,
  };
}
