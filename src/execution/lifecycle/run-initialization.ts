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
import chalk from "chalk";
import type { NaxConfig } from "../../config";
import { AgentNotFoundError, AgentNotInstalledError, StoryLimitExceededError } from "../../errors";
import { getSafeLogger } from "../../logger";
import type { AgentGetFn } from "../../pipeline/types";
import { countStories, loadPRD, markStoryPassed, savePRD } from "../../prd";
import type { PRD } from "../../prd/types";
import { runReview } from "../../review/runner";
import type { ReviewConfig } from "../../review/types";
import { hasCommitsForStory } from "../../utils/git";

/**
 * Injectable dependencies for reconcileState — allows tests to mock
 * hasCommitsForStory and runReview without mock.module().
 */
export const _reconcileDeps = {
  hasCommitsForStory: (workdir: string, storyId: string) => hasCommitsForStory(workdir, storyId),
  runReview: (reviewConfig: ReviewConfig, workdir: string, executionConfig: NaxConfig["execution"]) =>
    runReview(reviewConfig, workdir, executionConfig),
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
  let modified = false;

  for (const story of prd.userStories) {
    if (story.status !== "failed") continue;

    const hasCommits = await _reconcileDeps.hasCommitsForStory(workdir, story.id);
    if (!hasCommits) continue;

    // Gate: re-run review for stories that failed at review/autofix stage
    if (story.failureStage === "review" || story.failureStage === "autofix") {
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
    }

    logger?.warn("reconciliation", "Failed story has commits in git history, marking as passed", {
      storyId: story.id,
      title: story.title,
    });
    markStoryPassed(prd, story.id);
    reconciledCount++;
    modified = true;
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
  const { getAgent } = await import("../../agents");
  const agent = (agentGetFn ?? getAgent)(config.autoMode.defaultAgent);

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
  const protocol = config.agent?.protocol ?? "cli";
  logger?.info("run-initialization", `Agent protocol: ${protocol}`, { protocol });
}

/**
 * Initialize execution: validate agent, reconcile state, check limits
 */
export async function initializeRun(ctx: InitializationContext): Promise<InitializationResult> {
  const logger = getSafeLogger();

  // Check agent installation
  await checkAgentInstalled(ctx.config, ctx.dryRun, ctx.agentGetFn);

  // Load and reconcile PRD
  let prd = await loadPRD(ctx.prdPath);
  prd = await reconcileState(prd, ctx.prdPath, ctx.workdir, ctx.config);

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
