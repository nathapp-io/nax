/**
 * Run Initialization
 *
 * Handles initialization tasks before the main execution loop starts:
 * 1. State reconciliation (failed stories with commits)
 * 2. Agent installation check
 * 3. Story count validation
 * 4. Initial PRD analysis
 */

import { join } from "node:path";
import { getAgent } from "../../agents/registry";
import type { NaxConfig } from "../../config";
import { AgentNotFoundError, AgentNotInstalledError, StoryLimitExceededError } from "../../errors";
import { getSafeLogger } from "../../logger";
import type { AgentGetFn } from "../../pipeline/types";
import { countStories, loadPRD, markStoryPassed, resetFailedStoriesToPending, savePRD } from "../../prd";
import type { PRD } from "../../prd/types";
import { runReview } from "../../review/runner";
import type { ReviewConfig } from "../../review/types";
import { spawn } from "../../utils/bun-deps";
import { hasCommitsForStory } from "../../utils/git";

/**
 * Injectable dependencies for reconcileState — allows tests to mock
 * hasCommitsForStory and runReview without mock.module().
 */
export const _reconcileDeps = {
  getAgent,
  hasCommitsForStory: (workdir: string, storyId: string) => hasCommitsForStory(workdir, storyId),
  runReview: (reviewConfig: ReviewConfig, workdir: string, executionConfig: NaxConfig["execution"]) =>
    runReview(reviewConfig, workdir, executionConfig),
  spawn,
};

export interface InitializationContext {
  config: NaxConfig;
  prdPath: string;
  workdir: string;
  dryRun: boolean;
  /** Protocol-aware agent resolver — passed from registry at run start */
  agentGetFn?: AgentGetFn;
}

export interface InitializationResult {
  prd: PRD;
  storyCounts: {
    total: number;
    pending: number;
    passed: number;
    failed: number;
    skipped: number;
    paused: number;
    blocked: number;
  };
}

/**
 * Reconcile PRD state with git history
 *
 * Checks if failed stories have commits in git history and marks them as passed.
 * For stories that failed at review/autofix stage, re-runs the review before
 * reconciling to ensure the code quality issues were actually fixed.
 */
async function reconcileState(prd: PRD, prdPath: string, workdir: string, config: NaxConfig): Promise<PRD> {
  const logger = getSafeLogger();
  let reconciledCount = 0;

  for (const story of prd.userStories) {
    if (story.status !== "failed") continue;

    const hasCommits = await _reconcileDeps.hasCommitsForStory(workdir, story.id);
    if (!hasCommits) continue;

    // Only reconcile stories that failed at review/autofix stage — these have
    // completed code that just failed quality checks. All other failure stages
    // (execution, verify, regression, etc.) may have incomplete work despite
    // having commits in git history (e.g. rate limit mid-execution).
    if (story.failureStage !== "review" && story.failureStage !== "autofix") {
      logger?.debug("reconciliation", "Skipping non-review/autofix failure — not reconcilable", {
        storyId: story.id,
        failureStage: story.failureStage,
      });
      continue;
    }

    // Re-run review to confirm the quality issues were actually fixed
    const effectiveWorkdir = story.workdir ? join(workdir, story.workdir) : workdir;
    try {
      const reviewResult = await _reconcileDeps.runReview(config.review, effectiveWorkdir, config.execution);
      if (!reviewResult.success) {
        logger?.warn("reconciliation", "Review still fails — not reconciling story", {
          storyId: story.id,
          failureReason: reviewResult.failureReason,
        });
        continue;
      }
      logger?.info("reconciliation", "Review now passes — reconciling story", { storyId: story.id });
    } catch {
      // Non-fatal: if review check errors, skip reconciliation for this story
      logger?.warn("reconciliation", "Review check errored — not reconciling story", { storyId: story.id });
      continue;
    }

    logger?.warn("reconciliation", "Failed story has commits in git history, marking as passed", {
      storyId: story.id,
      title: story.title,
    });
    markStoryPassed(prd, story.id);
    reconciledCount++;
  }

  if (reconciledCount > 0) {
    logger?.info("reconciliation", `Reconciled ${reconciledCount} failed stories from git history`);
    await savePRD(prd, prdPath);
  }

  return prd;
}

/**
 * Validate agent installation
 */
async function checkAgentInstalled(config: NaxConfig, dryRun: boolean, agentGetFn?: AgentGetFn): Promise<void> {
  if (dryRun) return;

  const logger = getSafeLogger();
  const agent = (agentGetFn ?? _reconcileDeps.getAgent)(config.autoMode.defaultAgent);

  if (!agent) {
    logger?.error("execution", "Agent not found", {
      agent: config.autoMode.defaultAgent,
    });
    throw new AgentNotFoundError(config.autoMode.defaultAgent);
  }

  const installed = await agent.isInstalled();
  if (!installed) {
    logger?.error("execution", "Agent is not installed or not in PATH", {
      agent: config.autoMode.defaultAgent,
      binary: agent.binary,
    });
    logger?.error("execution", "Please install the agent and try again");
    throw new AgentNotInstalledError(config.autoMode.defaultAgent, agent.binary);
  }
}

/**
 * Validate story count doesn't exceed limit
 */
function validateStoryCount(counts: ReturnType<typeof countStories>, config: NaxConfig): void {
  const logger = getSafeLogger();

  if (counts.total > config.execution.maxStoriesPerFeature) {
    logger?.error("execution", "Feature exceeds story limit", {
      totalStories: counts.total,
      limit: config.execution.maxStoriesPerFeature,
    });
    logger?.error("execution", "Split this feature into smaller features or increase maxStoriesPerFeature in config");
    throw new StoryLimitExceededError(counts.total, config.execution.maxStoriesPerFeature);
  }
}

/**
 * Log the active agent protocol to aid debugging.
 */
export function logActiveProtocol(config: NaxConfig): void {
  const logger = getSafeLogger();
  const protocol = config.agent?.protocol;
  logger?.info("run-initialization", `Agent protocol: ${protocol}`, { protocol });
}

/**
 * Initialize execution: validate agent, reconcile state, check limits
 */
export async function initializeRun(ctx: InitializationContext): Promise<InitializationResult> {
  const logger = getSafeLogger();

  // Check agent installation
  await checkAgentInstalled(ctx.config, ctx.dryRun, ctx.agentGetFn);

  // EXEC-002: Log the story isolation mode for observability
  logger?.info("execution", "Story isolation mode", {
    storyIsolation: ctx.config.execution.storyIsolation,
  });

  // Load and reconcile PRD
  let prd = await loadPRD(ctx.prdPath);
  prd = await reconcileState(prd, ctx.prdPath, ctx.workdir, ctx.config);

  // Reset failed stories to pending so they are retried on re-run.
  // reconcileState runs first to promote failed→passed for git-committed stories;
  // remaining failed stories (incomplete work) are reset here so they re-enter the queue.
  const resetRef = ctx.config.review?.semantic?.resetRefOnRerun ?? false;
  const storyIsolation = ctx.config.execution.storyIsolation;
  const resetStories = resetFailedStoriesToPending(prd, resetRef, storyIsolation);
  if (resetStories.length > 0) {
    const resetIds = resetStories.map((s) => s.id);
    logger?.info("run-initialization", "Reset failed stories to pending for re-run", { storyIds: resetIds });

    // EXEC-002: In worktree mode, delete old nax/<storyId> branches so worktreeManager.create()
    // starts from a clean slate (fresh branch from current main HEAD).
    if (storyIsolation === "worktree") {
      for (const story of resetStories) {
        try {
          const proc = _reconcileDeps.spawn(["git", "branch", "-D", `nax/${story.id}`], {
            cwd: ctx.workdir,
            stdout: "pipe",
            stderr: "pipe",
          });
          const exitCode = await proc.exited;
          if (exitCode === 0) {
            logger?.info("worktree", "Cleaned up old branch for re-run", { storyId: story.id });
          } else {
            const stderr = await new Response(proc.stderr).text();
            if (!stderr.includes("not found")) {
              // Unexpected failure — warn but continue. If branch still exists, worktreeManager.create()
              // will crash on the next run with "branch already exists".
              logger?.warn("worktree", "Failed to clean up old branch for re-run (non-fatal)", {
                storyId: story.id,
                branch: `nax/${story.id}`,
                stderr: stderr.trim(),
              });
            }
            // "not found" → branch never existed (story failed before worktree creation) — silently skip
          }
        } catch {
          // Spawn failure — non-fatal, log nothing (branch may not exist)
        }
      }
    }

    await savePRD(prd, ctx.prdPath);
  }

  // Validate story counts
  const counts = countStories(prd);
  validateStoryCount(counts, ctx.config);

  logger?.info("execution", "Run initialization complete", {
    totalStories: counts.total,
    doneStories: counts.passed,
    pendingStories: counts.pending,
  });

  return { prd, storyCounts: counts };
}
