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
import type { NaxConfig } from "../config";
import { getSafeLogger } from "../logger";
import type { PluginRegistry } from "../plugins";
import { runReview } from "./runner";
import type { ReviewConfig, ReviewResult } from "./types";

async function getChangedFiles(workdir: string): Promise<string[]> {
  try {
    const [stagedProc, unstagedProc] = [
      spawn({ cmd: ["git", "diff", "--name-only", "--cached"], cwd: workdir, stdout: "pipe", stderr: "pipe" }),
      spawn({ cmd: ["git", "diff", "--name-only"], cwd: workdir, stdout: "pipe", stderr: "pipe" }),
    ];
    await Promise.all([stagedProc.exited, unstagedProc.exited]);
    const staged = (await new Response(stagedProc.stdout).text()).trim().split("\n").filter(Boolean);
    const unstaged = (await new Response(unstagedProc.stdout).text()).trim().split("\n").filter(Boolean);
    return Array.from(new Set([...staged, ...unstaged]));
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
  ): Promise<OrchestratorReviewResult> {
    const logger = getSafeLogger();

    const builtIn = await runReview(reviewConfig, workdir, executionConfig);

    if (!builtIn.success) {
      return { builtIn, success: false, failureReason: builtIn.failureReason, pluginFailed: false };
    }

    if (plugins) {
      const reviewers = plugins.getReviewers();
      if (reviewers.length > 0) {
        const changedFiles = await getChangedFiles(workdir);
        const pluginResults: ReviewResult["pluginReviewers"] = [];

        for (const reviewer of reviewers) {
          logger?.info("review", `Running plugin reviewer: ${reviewer.name}`, {
            changedFiles: changedFiles.length,
          });
          try {
            const result = await reviewer.check(workdir, changedFiles);
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
            const errorMsg = error instanceof Error ? error.message : String(error);
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
}

export const reviewOrchestrator = new ReviewOrchestrator();
