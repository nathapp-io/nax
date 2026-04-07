/**
 * Review Orchestrator (ADR-005, Phase 2)
 *
 * Single entry point for all post-implementation review. Delegates to the
 * review runner and plugin reviewers. Provides a unified result.
 *
 * Usage:
 *   const result = await reviewOrchestrator.review(config, workdir, executionConfig, plugins);
 */

import { spawn } from "bun";
import type { AgentAdapter } from "../agents/types";
import type { NaxConfig } from "../config";
import type { ModelTier } from "../config/schema-types";
import { getSafeLogger } from "../logger";
import type { PipelineContext } from "../pipeline/types";
import type { PluginRegistry } from "../plugins";
import { errorMessage } from "../utils/errors";
import { runReview } from "./runner";
import type { SemanticStory } from "./semantic";
import type { ReviewConfig, ReviewResult } from "./types";

/**
 * Injectable dependencies for getChangedFiles() — allows tests to intercept
 * spawn calls without requiring the git binary.
 *
 * @internal
 */
export const _orchestratorDeps = { spawn };

async function getChangedFiles(workdir: string, baseRef?: string): Promise<string[]> {
  try {
    const diffArgs = ["diff", "--name-only"];
    const [stagedProc, unstagedProc, baseProc] = [
      _orchestratorDeps.spawn({ cmd: ["git", ...diffArgs, "--cached"], cwd: workdir, stdout: "pipe", stderr: "pipe" }),
      _orchestratorDeps.spawn({ cmd: ["git", ...diffArgs], cwd: workdir, stdout: "pipe", stderr: "pipe" }),
      baseRef
        ? _orchestratorDeps.spawn({
            cmd: ["git", ...diffArgs, `${baseRef}...HEAD`],
            cwd: workdir,
            stdout: "pipe",
            stderr: "pipe",
          })
        : null,
    ];

    await Promise.all([stagedProc.exited, unstagedProc.exited, baseProc?.exited]);

    const [staged, unstaged, based] = await Promise.all([
      new Response(stagedProc.stdout).text().then((t) => t.trim().split("\n").filter(Boolean)),
      new Response(unstagedProc.stdout).text().then((t) => t.trim().split("\n").filter(Boolean)),
      baseProc
        ? new Response(baseProc.stdout).text().then((t) => t.trim().split("\n").filter(Boolean))
        : Promise.resolve([]),
    ]);

    return Array.from(new Set([...staged, ...unstaged, ...based]));
  } catch {
    return [];
  }
}

export interface OrchestratorReviewResult {
  /** Built-in review result (typecheck, lint, format) */
  builtIn: ReviewResult;
  /** Whether ALL checks passed (built-in + plugin reviewers) */
  success: boolean;
  /** Failure reason if success === false */
  failureReason?: string;
  /** Plugin reviewer hard-failure flag (determines escalate vs fail) */
  pluginFailed: boolean;
}

export class ReviewOrchestrator {
  /** Run built-in checks + plugin reviewers. Returns unified result. */
  async review(
    reviewConfig: ReviewConfig,
    workdir: string,
    executionConfig: NaxConfig["execution"],
    plugins?: PluginRegistry,
    storyGitRef?: string,
    scopePrefix?: string,
    qualityCommands?: NaxConfig["quality"]["commands"],
    storyId?: string,
    story?: SemanticStory,
    modelResolver?: (tier: ModelTier) => AgentAdapter | null | undefined,
    naxConfig?: NaxConfig,
    retrySkipChecks?: Set<string>,
    featureName?: string,
  ): Promise<OrchestratorReviewResult> {
    const logger = getSafeLogger();

    const builtIn = await runReview(
      reviewConfig,
      workdir,
      executionConfig,
      qualityCommands,
      storyId,
      storyGitRef,
      story,
      modelResolver,
      naxConfig,
      retrySkipChecks,
      featureName,
    );

    if (!builtIn.success) {
      return { builtIn, success: false, failureReason: builtIn.failureReason, pluginFailed: false };
    }

    if (reviewConfig.pluginMode === "deferred") {
      logger?.debug("review", "Plugin reviewers deferred — skipping per-story execution");
      return { builtIn, success: true, pluginFailed: false };
    }

    if (plugins) {
      const reviewers = plugins.getReviewers();
      if (reviewers.length > 0) {
        // Use the story's start ref if available to capture auto-committed changes
        const baseRef = storyGitRef ?? executionConfig?.storyGitRef;
        const changedFiles = await getChangedFiles(workdir, baseRef);
        const scopedFiles = scopePrefix
          ? changedFiles.filter((f) => f === scopePrefix || f.startsWith(`${scopePrefix}/`))
          : changedFiles;
        const pluginResults: ReviewResult["pluginReviewers"] = [];

        for (const reviewer of reviewers) {
          logger?.info("review", `Running plugin reviewer: ${reviewer.name}`, {
            changedFiles: scopedFiles.length,
          });
          try {
            const result = await reviewer.check(workdir, scopedFiles);
            // Always log the result so skips/passes are visible in the log
            logger?.info("review", `Plugin reviewer result: ${reviewer.name}`, {
              passed: result.passed,
              exitCode: result.exitCode,
              output: result.output?.slice(0, 500),
              findings: result.findings?.length ?? 0,
            });
            pluginResults.push({
              name: reviewer.name,
              passed: result.passed,
              output: result.output,
              exitCode: result.exitCode,
              findings: result.findings,
            });
            if (!result.passed) {
              builtIn.pluginReviewers = pluginResults;
              return {
                builtIn,
                success: false,
                failureReason: `plugin reviewer '${reviewer.name}' failed`,
                pluginFailed: true,
              };
            }
          } catch (error) {
            const errorMsg = errorMessage(error);
            logger?.warn("review", `Plugin reviewer threw error: ${reviewer.name}`, { error: errorMsg });
            pluginResults.push({ name: reviewer.name, passed: false, output: "", error: errorMsg });
            builtIn.pluginReviewers = pluginResults;
            return {
              builtIn,
              success: false,
              failureReason: `plugin reviewer '${reviewer.name}' threw error`,
              pluginFailed: true,
            };
          }
        }
        builtIn.pluginReviewers = pluginResults;
      }
    }

    return { builtIn, success: true, pluginFailed: false };
  }

  /**
   * Run review with a PipelineContext — reads all inputs from ctx.
   * Preferred API for pipeline stages.
   *
   * Consumes ctx.retrySkipChecks once (clears it after reading) so
   * subsequent retries re-evaluate all checks.
   */
  reviewFromContext(ctx: PipelineContext): Promise<OrchestratorReviewResult> {
    // #136: Consume retrySkipChecks once — cleared so subsequent retries re-evaluate
    const retrySkipChecks = ctx.retrySkipChecks;
    ctx.retrySkipChecks = undefined;

    const agentResolver = ctx.agentGetFn ?? undefined;
    const agentName = ctx.rootConfig.autoMode?.defaultAgent;
    const modelResolver = agentName
      ? (_tier: string) => (agentResolver ? (agentResolver(agentName) ?? null) : null)
      : undefined;

    return this.review(
      ctx.config.review,
      ctx.workdir,
      ctx.config.execution,
      ctx.plugins,
      ctx.storyGitRef,
      ctx.story.workdir, // relative path for git diff scoping (unchanged)
      ctx.config.quality?.commands,
      ctx.story.id,
      {
        id: ctx.story.id,
        title: ctx.story.title,
        description: ctx.story.description,
        acceptanceCriteria: ctx.story.acceptanceCriteria,
      },
      modelResolver,
      ctx.config,
      retrySkipChecks,
      ctx.prd.feature,
    );
  }
}

export const reviewOrchestrator = new ReviewOrchestrator();
