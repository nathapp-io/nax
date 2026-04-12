/**
 * Review Runner
 *
 * Runs configurable quality checks after story implementation
 */

import type { AgentAdapter } from "../agents/types";
import type { NaxConfig } from "../config";
import type { ExecutionConfig, QualityConfig } from "../config/schema";
import type { ModelTier } from "../config/schema-types";
import { getSafeLogger } from "../logger";
import { runQualityCommand } from "../quality";
import { autoCommitIfDirty } from "../utils/git";
import { resolveLanguageCommand } from "./language-commands";
import { runSemanticReview as _runSemanticReviewImpl } from "./semantic";
import type { SemanticStory } from "./semantic";
import type { ReviewCheckName, ReviewCheckResult, ReviewConfig, ReviewResult } from "./types";

// Re-export for test compatibility
export { resolveLanguageCommand };

/**
 * Injectable dependency for the semantic review call — allows tests to
 * intercept runSemanticReview() without mock.module() (BUG-035 pattern).
 *
 * @internal
 */
export const _reviewSemanticDeps = {
  runSemanticReview: _runSemanticReviewImpl,
};

/**
 * Injectable dependencies for runner internals — allows tests to intercept
 * Bun.file and Bun.which calls without mock.module().
 *
 * @internal
 */
export const _reviewRunnerDeps = {
  file: Bun.file,
  which: Bun.which as (command: string) => string | null,
};

/**
 * Load package.json from workdir
 */
async function loadPackageJson(workdir: string): Promise<Record<string, unknown> | null> {
  try {
    const file = _reviewRunnerDeps.file(`${workdir}/package.json`);
    const content = await file.text();
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Check if package.json has a script
 */
function hasScript(packageJson: Record<string, unknown> | null, scriptName: string): boolean {
  if (!packageJson) return false;
  const scripts = packageJson.scripts;
  if (typeof scripts !== "object" || scripts === null) return false;
  return scriptName in scripts;
}

/**
 * Resolve command for a check
 * Resolution order:
 * 1. Explicit executionConfig field (lintCommand/typecheckCommand) - null = disabled
 * 2. config.review.commands[check] (explicit review config)
 * 3. quality.commands[check] (fallback — package config without review section)
 * 4. Language-aware fallback (binary check via Bun.which) — US-004
 * 5. package.json has script -> use 'bun run <script>'
 * 6. Not found -> return null (skip)
 */
export async function resolveCommand(
  check: ReviewCheckName,
  config: ReviewConfig,
  executionConfig: ExecutionConfig | undefined,
  workdir: string,
  qualityCommands?: QualityConfig["commands"],
  profile?: { language?: string },
): Promise<string | null> {
  // Semantic checks don't have CLI commands — they're handled separately by the review orchestrator
  if (check === "semantic") {
    return null;
  }

  // 1. Check explicit config.execution commands (v0.13 story)
  if (executionConfig) {
    if (check === "lint" && executionConfig.lintCommand !== undefined) {
      return executionConfig.lintCommand; // null = disabled
    }
    if (check === "typecheck" && executionConfig.typecheckCommand !== undefined) {
      return executionConfig.typecheckCommand; // null = disabled
    }
  }

  // 2. Check config.review.commands (explicit review config)
  const cmd = config.commands[check as keyof typeof config.commands];
  if (cmd) {
    return cmd ?? null;
  }

  // 3. Fallback to quality.commands — lets package configs specify commands once
  //    without duplicating them under review. Catches cases where story.workdir is
  //    unset and the PKG-006 merge-time bridge hasn't run.
  const qualityCmd = qualityCommands?.[check as keyof typeof qualityCommands];
  if (qualityCmd) {
    return qualityCmd;
  }

  // 4. Language-aware fallback — binary availability checked via Bun.which()
  if (profile?.language) {
    const langCmd = resolveLanguageCommand(profile.language, check, _reviewRunnerDeps.which);
    if (langCmd !== null) {
      return langCmd;
    }
  }

  // 5. Check package.json — only for built-in checks (typecheck/lint/test), not build.
  // build must be explicitly configured in review.commands or quality.commands.
  if (check !== "build") {
    const packageJson = await loadPackageJson(workdir);
    if (hasScript(packageJson, check)) {
      return `bun run ${check}`;
    }
  }

  // 6. Not found - return null to skip
  return null;
}

/**
 * Run a single review check by delegating to the shared runQualityCommand
 * utility. Maps QualityCommandResult back to the ReviewCheckResult shape.
 *
 * BUG-039: Timeout + SIGTERM/SIGKILL handling lives in runQualityCommand.
 */
async function runCheck(
  check: ReviewCheckName,
  command: string,
  workdir: string,
  storyId?: string,
): Promise<ReviewCheckResult> {
  const result = await runQualityCommand({ commandName: check, command, workdir, storyId });
  return {
    check,
    command: result.command,
    success: result.success,
    exitCode: result.exitCode,
    output: result.output,
    durationMs: result.durationMs,
  };
}

/**
 * Get uncommitted tracked files via git diff --name-only HEAD.
 * Returns empty array if git command fails or working tree is clean.
 */
async function getUncommittedFilesImpl(workdir: string): Promise<string[]> {
  try {
    const proc = Bun.spawn({
      cmd: ["git", "diff", "--name-only", "HEAD"],
      cwd: workdir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      return [];
    }

    const output = await new Response(proc.stdout).text();
    return output.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Swappable dependencies for testing (avoids mock.module() which leaks in Bun 1.x).
 * RQ-001: getUncommittedFiles enables mocking of the git dirty-tree check.
 */
export const _reviewGitDeps = {
  /** Returns tracked files with uncommitted changes (git diff --name-only HEAD). */
  getUncommittedFiles: getUncommittedFilesImpl,
};

/**
 * Run all configured review checks
 */
export async function runReview(
  config: ReviewConfig,
  workdir: string,
  executionConfig?: ExecutionConfig,
  qualityCommands?: QualityConfig["commands"],
  storyId?: string,
  storyGitRef?: string,
  story?: SemanticStory,
  modelResolver?: (tier: ModelTier) => AgentAdapter | null | undefined,
  naxConfig?: NaxConfig,
  retrySkipChecks?: Set<string>,
  featureName?: string,
  resolverSession?: import("./dialogue").ReviewerSession,
  priorFailures?: Array<{ stage: string; modelTier: string }>,
): Promise<ReviewResult> {
  const startTime = Date.now();
  const logger = getSafeLogger();
  const checks: ReviewCheckResult[] = [];
  let firstFailure: string | undefined;

  // BUG-074: Auto-commit any dirty files the agent left (e.g. bun.lock / package.json
  // after `bun add`) before the uncommitted-changes check. Mirrors BUG-058/063.
  await autoCommitIfDirty(workdir, "review", "agent", storyId ?? "review");

  // RQ-001: Check for uncommitted tracked files before running checks
  const allUncommittedFiles = await _reviewGitDeps.getUncommittedFiles(workdir);
  // Exclude nax runtime files — written by nax itself during the run, not by the agent.
  // Patterns use a suffix match (no leading ^) so they work in both single-package repos
  // (nax/features/…) and monorepos where paths are prefixed (apps/cli/nax/features/…).
  const NAX_RUNTIME_PATTERNS = [
    /nax\.lock$/,
    /nax\/metrics\.json$/,
    /nax\/status\.json$/,
    /nax\/features\/[^/]+\/status\.json$/,
    /nax\/features\/[^/]+\/prd\.json$/,
    /nax\/features\/[^/]+\/runs\//,
    /nax\/features\/[^/]+\/plan\//,
    /nax\/features\/[^/]+\/acp-sessions\.json$/,
    /nax\/features\/[^/]+\/interactions\//,
    /nax\/features\/[^/]+\/progress\.txt$/,
    /nax\/features\/[^/]+\/acceptance-refined\.json$/,
    /\.nax-verifier-verdict\.json$/,
    /\.nax-pids$/,
    /\.nax-wt\//,
    /\.nax-acceptance[^/]*$/,
  ];
  const uncommittedFiles = allUncommittedFiles.filter((f) => !NAX_RUNTIME_PATTERNS.some((pattern) => pattern.test(f)));
  if (uncommittedFiles.length > 0) {
    const fileList = uncommittedFiles.join(", ");
    logger?.warn("review", `Uncommitted changes detected before review: ${fileList}`);
    return {
      success: false,
      checks: [],
      totalDurationMs: Date.now() - startTime,
      failureReason: `Working tree has uncommitted changes:\n${uncommittedFiles.map((f) => `  - ${f}`).join("\n")}\n\nStage and commit these files before running review.`,
    };
  }

  for (const checkName of config.checks) {
    // #136: Skip checks that already passed in a previous review pass within this pipeline run.
    // Populated by autofix stage when retrying — only skips checks that were NOT the failing check.
    if (retrySkipChecks?.has(checkName)) {
      getSafeLogger()?.debug("review", `Skipping ${checkName} check (already passed in previous review pass)`, {
        storyId,
      });
      continue;
    }

    // Semantic check: delegate to LLM-based runner instead of shell command
    if (checkName === "semantic") {
      const semanticStory: SemanticStory = {
        id: storyId ?? "",
        title: story?.title ?? "",
        description: story?.description ?? "",
        acceptanceCriteria: story?.acceptanceCriteria ?? [],
      };
      const semanticCfg = config.semantic ?? {
        modelTier: "balanced" as const,
        diffMode: "embedded" as const,
        resetRefOnRerun: false,
        rules: [] as string[],
        timeoutMs: 600_000,
        excludePatterns: [
          ":!test/",
          ":!tests/",
          ":!*_test.go",
          ":!*.test.ts",
          ":!*.spec.ts",
          ":!**/__tests__/",
          ":!.nax/",
          ":!.nax-pids",
        ],
      };
      const runSemantic = _reviewSemanticDeps.runSemanticReview;
      const result = await runSemantic(
        workdir,
        storyGitRef,
        semanticStory,
        semanticCfg,
        modelResolver ?? (() => null),
        naxConfig,
        featureName,
        resolverSession,
        priorFailures,
      );
      checks.push(result);
      if (!result.success && !firstFailure) {
        firstFailure = `${checkName} failed`;
      }
      if (!result.success) {
        break;
      }
      continue;
    }

    // Resolve command using resolution strategy
    const command = await resolveCommand(checkName, config, executionConfig, workdir, qualityCommands);

    // Skip if explicitly disabled or not found
    if (command === null) {
      getSafeLogger()?.warn("review", `Skipping ${checkName} check (command not configured or disabled)`);
      continue;
    }

    // Run the check
    const result = await runCheck(checkName, command, workdir, storyId);
    checks.push(result);

    // Track first failure
    if (!result.success && !firstFailure) {
      firstFailure = `${checkName} failed (exit code ${result.exitCode})`;
    }

    // Stop on first failure (fail-fast)
    if (!result.success) {
      break;
    }
  }

  const allPassed = checks.every((c) => c.success);

  return {
    success: allPassed,
    checks,
    totalDurationMs: Date.now() - startTime,
    failureReason: firstFailure,
  };
}
