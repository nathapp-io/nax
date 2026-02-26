/**
 * Review Stage
 *
 * Runs post-implementation review phase if enabled.
 * Checks code quality, tests, linting, etc. via review module.
 * After built-in checks, runs plugin reviewers if any are registered.
 *
 * @returns
 * - `continue`: Review passed
 * - `fail`: Review failed (hard failure)
 *
 * @example
 * ```ts
 * // Review enabled and passes
 * await reviewStage.execute(ctx);
 * // ctx.reviewResult: { success: true, totalDurationMs: 1500, ... }
 *
 * // Review enabled but fails
 * await reviewStage.execute(ctx);
 * // Returns: { action: "fail", reason: "Review failed: typecheck errors" }
 * ```
 */

import { spawn } from "bun";
import { getLogger } from "../../logger";
import { runReview } from "../../review";
import type { PipelineContext, PipelineStage, StageResult } from "../types";

/**
 * Get list of changed files from git.
 *
 * @param workdir - Working directory
 * @returns Array of changed file paths
 */
async function getChangedFiles(workdir: string): Promise<string[]> {
  try {
    const proc = spawn({
      cmd: ["git", "diff", "--name-only", "HEAD"],
      cwd: workdir,
      stdout: "pipe",
      stderr: "pipe",
    });

    await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    return stdout
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

export const reviewStage: PipelineStage = {
  name: "review",
  enabled: (ctx) => ctx.config.review.enabled,

  async execute(ctx: PipelineContext): Promise<StageResult> {
    const logger = getLogger();

    logger.info("review", "Running review phase");

    // Run built-in checks (typecheck, lint, test)
    const reviewResult = await runReview(ctx.config.review, ctx.workdir);
    ctx.reviewResult = reviewResult;

    // HARD FAILURE: Review failure means code quality gate not met
    if (!reviewResult.success) {
      logger.error("review", "Review failed (built-in checks)", {
        reason: reviewResult.failureReason,
        storyId: ctx.story.id,
      });
      return { action: "fail", reason: `Review failed: ${reviewResult.failureReason}` };
    }

    // Run plugin reviewers if any are registered
    if (ctx.plugins) {
      const pluginReviewers = ctx.plugins.getReviewers();
      if (pluginReviewers.length > 0) {
        logger.info("review", `Running ${pluginReviewers.length} plugin reviewer(s)`);

        const changedFiles = await getChangedFiles(ctx.workdir);
        const pluginReviewerResults: Array<{
          name: string;
          passed: boolean;
          output: string;
          exitCode?: number;
          error?: string;
        }> = [];

        for (const reviewer of pluginReviewers) {
          logger.info("review", `Running plugin reviewer: ${reviewer.name}`);
          try {
            const result = await reviewer.check(ctx.workdir, changedFiles);

            // Capture result for debugging
            pluginReviewerResults.push({
              name: reviewer.name,
              passed: result.passed,
              output: result.output,
              exitCode: result.exitCode,
            });

            if (!result.passed) {
              logger.error("review", `Plugin reviewer failed: ${reviewer.name}`, {
                output: result.output,
                storyId: ctx.story.id,
              });

              // Store results in review result before failing
              if (ctx.reviewResult) {
                ctx.reviewResult.pluginReviewers = pluginReviewerResults;
              }

              return {
                action: "fail",
                reason: `Review failed: plugin reviewer '${reviewer.name}' failed`,
              };
            }

            logger.info("review", `Plugin reviewer passed: ${reviewer.name}`);
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            logger.error("review", `Plugin reviewer error: ${reviewer.name}`, {
              error: errorMsg,
              storyId: ctx.story.id,
            });

            // Capture error for debugging
            pluginReviewerResults.push({
              name: reviewer.name,
              passed: false,
              output: "",
              error: errorMsg,
            });

            // Store results in review result before failing
            if (ctx.reviewResult) {
              ctx.reviewResult.pluginReviewers = pluginReviewerResults;
            }

            return {
              action: "fail",
              reason: `Review failed: plugin reviewer '${reviewer.name}' threw error`,
            };
          }
        }

        // Store successful plugin reviewer results
        if (ctx.reviewResult) {
          ctx.reviewResult.pluginReviewers = pluginReviewerResults;
        }
      }
    }

    logger.info("review", "Review passed", {
      durationMs: reviewResult.totalDurationMs,
      storyId: ctx.story.id,
    });
    return { action: "continue" };
  },
};
