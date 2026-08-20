/**
 * Review Runner
 *
 * Runs configurable quality checks after story implementation
 */

import type { IAgentManager } from "@/agents";
import type { ExecutionConfig, QualityConfig } from "@/config/schema";
import type { ReviewConfig as ReviewNaxConfig } from "@/config/selectors";
import type { Iteration } from "@/findings";
import { getSafeLogger } from "@/logger";
import type { UserStory } from "@/prd";
import { runQualityCommand } from "@/quality";
import { autoCommitIfDirty, gitWithTimeout } from "@/utils/git";
import type { NaxIgnoreIndex } from "@/utils/path-filters";
import { runAdversarialReview as _runAdversarialReviewImpl } from "../adversarial";
import { resolveLanguageCommand } from "../language-commands";
import { runScopedLintCheck } from "../scoped-lint";
import { runSemanticReview as _runSemanticReviewImpl } from "../semantic";
import type { SemanticStory } from "../semantic";
import { parseTypecheckOutput } from "../typecheck-parsing";
import type { ReviewCheckName, ReviewCheckResult, ReviewConfig, ReviewResult } from "../types";

// Re-export for test compatibility
export { resolveLanguageCommand };

export interface RunReviewOptions {
  config: ReviewConfig;
  workdir: string;
  executionConfig?: ExecutionConfig;
  qualityCommands?: QualityConfig["commands"];
  storyId?: string;
  storyGitRef?: string;
  story?: SemanticStory;
  agentManager?: IAgentManager;
  naxConfig?: ReviewNaxConfig;
  retrySkipChecks?: Set<string>;
  featureName?: string;
  priorFailures?: Array<{ stage: string; modelTier: string }>;
  priorSemanticIterations?: Iteration[];
  featureContextMarkdown?: string;
  contextBundles?: {
    semantic?: import("@/context/engine").ContextBundle;
    adversarial?: import("@/context/engine").ContextBundle;
  };
  projectDir?: string;
  env?: Record<string, string | undefined>;
  naxIgnoreIndex?: NaxIgnoreIndex;
  runtime?: import("@/runtime").NaxRuntime;
  priorAdversarialIterations?: Iteration[];
}

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
 * Injectable dependency for the adversarial review call — allows tests to
 * intercept runAdversarialReview() without mock.module() (BUG-035 pattern).
 *
 * @internal
 */
export const _reviewAdversarialDeps = {
  runAdversarialReview: _runAdversarialReviewImpl,
};

export const _reviewLintDeps = {
  runScopedLintCheck,
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
  // Semantic and adversarial checks are LLM-based — handled separately by the review orchestrator
  if (check === "semantic" || check === "adversarial") {
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
  env?: Record<string, string | undefined>,
  stripEnvVars?: string[],
): Promise<ReviewCheckResult> {
  const result = await runQualityCommand({ commandName: check, command, workdir, storyId, env, stripEnvVars });
  return {
    check,
    command: result.command,
    success: result.success,
    exitCode: result.exitCode,
    output: result.output,
    durationMs: result.durationMs,
  };
}

function normalizeMechanicalFindings(
  checkName: ReviewCheckName,
  result: ReviewCheckResult,
  workdir: string,
): ReviewCheckResult {
  if (result.success) return result;
  if (checkName !== "typecheck") return result;
  const parsed = parseTypecheckOutput(result.output, "auto", { workdir });
  if (!parsed?.findings || parsed.findings.length === 0) return result;
  return { ...result, findings: parsed.findings };
}

/**
 * Get uncommitted tracked files via git diff --name-only HEAD.
 * Returns empty array if git command fails or working tree is clean.
 *
 * BUG-1: routes through gitWithTimeout so >64KB of `git diff --name-only HEAD`
 * output (large diffs) cannot deadlock the run. Pre-fix the implementation
 * awaited proc.exited before draining stdout; once the OS pipe buffer fills,
 * git blocks writing and proc.exited never resolves. gitWithTimeout drains
 * stdout/stderr concurrently and SIGKILLs after GIT_TIMEOUT_MS.
 */
async function getUncommittedFilesImpl(workdir: string): Promise<string[]> {
  try {
    const { stdout, exitCode } = await gitWithTimeout(["diff", "--name-only", "HEAD"], workdir);
    if (exitCode !== 0) {
      return [];
    }
    return stdout.trim().split("\n").filter(Boolean);
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

// Exclude nax runtime files — written by nax itself during the run, not by the agent.
// Patterns use a suffix match (no leading ^) so they work in both single-package repos
// (nax/features/…) and monorepos where paths are prefixed (apps/cli/nax/features/…).
// Module-scoped (not per-call): the pattern list is static, so rebuilding it inside
// guardUncommittedFiles on every review would just be wasted allocation.
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
  /nax\/features\/[^/]+\/stories\/[^/]+\/context-manifest-[^/]+\.json$/,
  /nax\/features\/[^/]+\/stories\/[^/]+\/rebuild-manifest\.json$/,
  /\.nax-verifier-verdict\.json$/,
  /\.nax-pids$/,
  /\.nax-wt\//,
  /\.nax-acceptance[^/]*$/,
  /_nax_acceptance_test\.py$/,
  /_nax_suggested_test\.py$/,
  // Test-output artifacts — transient files leaked by tests, not agent changes.
  // 2B migrated logging.test.ts to a temp dir; these guard against future leak patterns.
  // Patterns match both repo-root paths (test/...) and monorepo-prefixed paths (.../test/...).
  /(?:^|\/)test\/.*\.jsonl$/,
  /(?:^|\/)coverage\//,
  /\.lcov$/,
];

/**
 * RQ-001: warn (never block) about tracked files left uncommitted before review runs.
 * @design: BUG-074: autoCommitIfDirty runs first to sweep up dirty files the agent
 * left (e.g. bun.lock / package.json after `bun add`) before the check. Mirrors BUG-058/063.
 */
async function guardUncommittedFiles(
  workdir: string,
  storyId: string | undefined,
  runtime: RunReviewOptions["runtime"],
  naxIgnoreIndex: NaxIgnoreIndex | undefined,
  logger: ReturnType<typeof getSafeLogger>,
): Promise<void> {
  await autoCommitIfDirty(workdir, "review", "agent", storyId ?? "review", runtime?.dirtyWorktrees);

  const allUncommittedFiles = await _reviewGitDeps.getUncommittedFiles(workdir);
  const afterRuntimeFilter = allUncommittedFiles.filter(
    (f) => !NAX_RUNTIME_PATTERNS.some((pattern) => pattern.test(f)),
  );
  // Apply .naxignore as a second, user-extensible layer on top of the built-in patterns.
  // Pass workdir as packageDir so per-package .naxignore rules apply in monorepos.
  const uncommittedFiles = naxIgnoreIndex ? naxIgnoreIndex.filter(afterRuntimeFilter, workdir) : afterRuntimeFilter;
  if (uncommittedFiles.length > 0) {
    // Warn but continue — autoCommitIfDirty already ran above as the primary guard.
    // Any files still dirty here are either infra artifacts or edge cases (e.g. a
    // cross-package file the add missed). Escalation cannot fix structural commit-scope
    // gaps and only wastes tokens, so we proceed with the review on what IS committed.
    const fileList = uncommittedFiles.join(", ");
    logger?.warn("review", `Uncommitted changes detected before review (proceeding): ${fileList}`, {
      storyId,
      uncommittedCount: uncommittedFiles.length,
    });
  }
}

/** Shared story shape both LLM reviewers (semantic, adversarial) build from RunReviewOptions. */
function buildReviewStory(storyId: string | undefined, story: SemanticStory | undefined): SemanticStory {
  return {
    id: storyId ?? "",
    title: story?.title ?? "",
    description: story?.description ?? "",
    acceptanceCriteria: story?.acceptanceCriteria ?? [],
  };
}

/** Semantic check: delegate to the LLM-based semantic reviewer instead of a shell command. */
async function runSemanticCheck(opts: RunReviewOptions): Promise<ReviewCheckResult> {
  const {
    workdir,
    storyGitRef,
    story,
    storyId,
    config,
    agentManager,
    naxConfig,
    featureName,
    priorSemanticIterations,
    featureContextMarkdown,
    contextBundles,
    projectDir,
    naxIgnoreIndex,
    runtime,
  } = opts;
  const semanticCfg = config.semantic ?? {
    model: "balanced" as const,
    diffMode: "ref" as const,
    resetRefOnRerun: false,
    rules: [] as string[],
    timeoutMs: 600_000,
    // excludePatterns omitted — runSemanticReview derives via resolveReviewExcludePatterns (ADR-009)
  };
  const runSemantic = _reviewSemanticDeps.runSemanticReview;
  return runSemantic({
    workdir,
    storyGitRef,
    story: buildReviewStory(storyId, story),
    semanticConfig: semanticCfg,
    agentManager,
    naxConfig,
    featureName,
    priorSemanticIterations,
    blockingThreshold: config.blockingThreshold,
    featureContextMarkdown,
    contextBundle: contextBundles?.semantic,
    projectDir,
    naxIgnoreIndex,
    runtime,
  });
}

/** Adversarial check: delegate to the LLM-based adversarial reviewer instead of a shell command. */
async function runAdversarialCheck(opts: RunReviewOptions): Promise<ReviewCheckResult> {
  const {
    workdir,
    storyGitRef,
    story,
    storyId,
    config,
    agentManager,
    naxConfig,
    featureName,
    priorFailures,
    featureContextMarkdown,
    contextBundles,
    projectDir,
    naxIgnoreIndex,
    runtime,
    priorAdversarialIterations,
  } = opts;
  const adversarialCfg = config.adversarial ?? {
    model: "balanced" as const,
    diffMode: "ref" as const,
    rules: [] as string[],
    timeoutMs: 600_000,
    // excludePatterns omitted — collectDiff always appends ALWAYS_EXCLUDED (.nax/ etc.) (ADR-009)
    parallel: false,
    maxConcurrentSessions: 2,
  };
  const runAdversarial = _reviewAdversarialDeps.runAdversarialReview;
  return runAdversarial({
    workdir,
    storyGitRef,
    story: buildReviewStory(storyId, story),
    adversarialConfig: adversarialCfg,
    agentManager,
    config: naxConfig,
    featureName,
    priorFailures,
    blockingThreshold: config.blockingThreshold,
    featureContextMarkdown,
    contextBundle: contextBundles?.adversarial,
    projectDir,
    naxIgnoreIndex,
    runtime,
    priorAdversarialIterations,
  });
}

/**
 * Mechanical check (lint / typecheck / build / ...): resolve its command and run it via
 * runQualityCommand (or the scoped-lint path for "lint"). Returns null when the check is
 * skipped (command not configured or disabled).
 */
async function runMechanicalCheck(
  checkName: ReviewCheckName,
  opts: RunReviewOptions,
): Promise<ReviewCheckResult | null> {
  const {
    config,
    workdir,
    executionConfig,
    qualityCommands,
    storyId,
    story,
    storyGitRef,
    naxConfig,
    projectDir,
    env,
    naxIgnoreIndex,
  } = opts;

  // Resolve command using resolution strategy
  const command = await resolveCommand(checkName, config, executionConfig, workdir, qualityCommands);

  // Skip if explicitly disabled or not found
  if (command === null) {
    getSafeLogger()?.warn("review", `Skipping ${checkName} check (command not configured or disabled)`);
    return null;
  }

  // Run the check
  return checkName === "lint"
    ? await _reviewLintDeps.runScopedLintCheck({
        resolvedLintCommand: command,
        configCommands: config.commands,
        qualityCommands,
        lintOutputFormat: naxConfig?.quality?.lintOutput?.format ?? "auto",
        workdir,
        projectDir,
        storyId,
        story: story as UserStory | undefined,
        storyGitRef,
        env,
        stripEnvVars: naxConfig?.quality?.stripEnvVars ?? [],
        naxIgnoreIndex,
      })
    : normalizeMechanicalFindings(
        checkName,
        await runCheck(checkName, command, workdir, storyId, env, naxConfig?.quality?.stripEnvVars ?? []),
        workdir,
      );
}

/**
 * Run all configured review checks
 */
export async function runReview(opts: RunReviewOptions): Promise<ReviewResult> {
  const { config, workdir, storyId, retrySkipChecks, naxIgnoreIndex, runtime } = opts;
  const startTime = Date.now();
  const logger = getSafeLogger();
  const checks: ReviewCheckResult[] = [];
  let firstFailure: string | undefined;

  // RQ-001: Check for uncommitted tracked files before running checks
  await guardUncommittedFiles(workdir, storyId, runtime, naxIgnoreIndex, logger);

  for (const checkName of config.checks) {
    // #136: Skip checks that already passed in a previous review pass within this pipeline run.
    // Populated by autofix stage when retrying — only skips checks that were NOT the failing check.
    if (retrySkipChecks?.has(checkName)) {
      getSafeLogger()?.debug("review", `Skipping ${checkName} check (already passed in previous review pass)`, {
        storyId,
      });
      continue;
    }

    if (checkName === "semantic" || checkName === "adversarial") {
      const result = checkName === "semantic" ? await runSemanticCheck(opts) : await runAdversarialCheck(opts);
      checks.push(result);
      if (!result.success && !firstFailure) {
        firstFailure = `${checkName} failed`;
      }
      if (!result.success) {
        break;
      }
      continue;
    }

    const result = await runMechanicalCheck(checkName, opts);
    if (result === null) continue;
    checks.push(result);

    // Log outcome of mechanical checks (lint / typecheck / build).
    // Semantic and adversarial checks log their own outcomes internally.
    if (result.success) {
      logger?.info("review", `${checkName} passed`, {
        storyId,
        durationMs: result.durationMs,
      });
    } else {
      logger?.warn("review", `${checkName} failed`, {
        storyId,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
      });
    }

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
