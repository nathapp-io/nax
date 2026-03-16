/**
 * TDD Session Runner
 *
 * Extracted from orchestrator.ts: runTddSession, truncateTestOutput, rollbackToRef
 */

import type { AgentAdapter } from "../agents";
import type { ModelTier, NaxConfig } from "../config";
import { resolveModel } from "../config";
import { resolvePermissions } from "../config/permissions";
import { getLogger } from "../logger";
import type { UserStory } from "../prd";
import { PromptBuilder } from "../prompts";
import { autoCommitIfDirty as _autoCommitIfDirtyFn } from "../utils/git";
import { cleanupProcessTree } from "./cleanup";

/**
 * Injectable dependencies for session-runner — allows tests to mock
 * autoCommitIfDirty without going through internal git deps.
 * @internal
 */
export const _sessionRunnerDeps = {
  autoCommitIfDirty: _autoCommitIfDirtyFn,
};
import { getChangedFiles, verifyImplementerIsolation, verifyTestWriterIsolation } from "./isolation";
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

  const resetProc = Bun.spawn(["git", "reset", "--hard", ref], {
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

  const cleanProc = Bun.spawn(["git", "clean", "-fd"], {
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
): Promise<TddSessionResult> {
  const startTime = Date.now();

  // Build prompt based on role and mode (lite vs strict)
  let prompt: string;
  switch (role) {
    case "test-writer":
      prompt = await PromptBuilder.for("test-writer", { isolation: lite ? "lite" : "strict" })
        .withLoader(workdir, config)
        .story(story)
        .context(contextMarkdown)
        .constitution(constitution)
        .testCommand(config.quality?.commands?.test)
        .build();
      break;
    case "implementer":
      prompt = await PromptBuilder.for("implementer", { variant: lite ? "lite" : "standard" })
        .withLoader(workdir, config)
        .story(story)
        .context(contextMarkdown)
        .constitution(constitution)
        .testCommand(config.quality?.commands?.test)
        .build();
      break;
    case "verifier":
      prompt = await PromptBuilder.for("verifier")
        .withLoader(workdir, config)
        .story(story)
        .context(contextMarkdown)
        .constitution(constitution)
        .testCommand(config.quality?.commands?.test)
        .build();
      break;
  }

  const logger = getLogger();
  logger.info("tdd", `-> Session: ${role}`, { role, storyId: story.id, lite });

  // Run the agent
  const result = await agent.run({
    prompt,
    workdir,
    modelTier,
    modelDef: resolveModel(config.models[modelTier]),
    timeoutSeconds: config.execution.sessionTimeoutSeconds,
    dangerouslySkipPermissions: resolvePermissions(config, "run").skipPermissions,
    pipelineStage: "run",
    config,
    maxInteractionTurns: config.agent?.maxInteractionTurns,
    featureName,
    storyId: story.id,
    sessionRole: role,
  });

  // BUG-21 Fix: Clean up orphaned child processes if agent failed
  if (!result.success && result.pid) {
    await cleanupProcessTree(result.pid);
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
    });
  }

  // BUG-058: Auto-commit if agent left uncommitted changes
  await _sessionRunnerDeps.autoCommitIfDirty(workdir, "tdd", role, story.id);

  // Check isolation based on role and skipIsolation flag.
  let isolation: IsolationCheck | undefined;
  if (!skipIsolation) {
    if (role === "test-writer") {
      const allowedPaths = config.tdd.testWriterAllowedPaths ?? ["src/index.ts", "src/**/index.ts"];
      isolation = await verifyTestWriterIsolation(workdir, beforeRef, allowedPaths);
    } else if (role === "implementer" || role === "verifier") {
      isolation = await verifyImplementerIsolation(workdir, beforeRef);
    }
  }

  // Get changed files
  const filesChanged = await getChangedFiles(workdir, beforeRef);

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
