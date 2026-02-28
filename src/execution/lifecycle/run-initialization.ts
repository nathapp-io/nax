/**
 * Run Initialization
 *
 * Handles initialization tasks before the main execution loop starts:
 * 1. State reconciliation (failed stories with commits)
 * 2. Agent installation check
 * 3. Story count validation
 * 4. Initial PRD analysis
 */

import chalk from "chalk";
import { getAgent } from "../../agents";
import type { NaxConfig } from "../../config";
import { AgentNotFoundError, AgentNotInstalledError, StoryLimitExceededError } from "../../errors";
import { getSafeLogger } from "../../logger";
import { countStories, loadPRD, markStoryPassed, savePRD } from "../../prd";
import type { PRD } from "../../prd/types";
import { hasCommitsForStory } from "../../utils/git";

export interface InitializationContext {
  config: NaxConfig;
  prdPath: string;
  workdir: string;
  dryRun: boolean;
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
 * This handles the case where TDD failed but agent already committed code.
 */
async function reconcileState(prd: PRD, prdPath: string, workdir: string): Promise<PRD> {
  const logger = getSafeLogger();
  let reconciledCount = 0;
  let modified = false;

  for (const story of prd.userStories) {
    if (story.status === "failed") {
      const hasCommits = await hasCommitsForStory(workdir, story.id);
      if (hasCommits) {
        logger?.warn("reconciliation", "Failed story has commits in git history, marking as passed", {
          storyId: story.id,
          title: story.title,
        });
        markStoryPassed(prd, story.id);
        reconciledCount++;
        modified = true;
      }
    }
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
async function checkAgentInstalled(config: NaxConfig, dryRun: boolean): Promise<void> {
  if (dryRun) return;

  const logger = getSafeLogger();
  const agent = getAgent(config.autoMode.defaultAgent);

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
 * Initialize execution: validate agent, reconcile state, check limits
 */
export async function initializeRun(ctx: InitializationContext): Promise<InitializationResult> {
  const logger = getSafeLogger();

  // Check agent installation
  await checkAgentInstalled(ctx.config, ctx.dryRun);

  // Load and reconcile PRD
  let prd = await loadPRD(ctx.prdPath);
  prd = await reconcileState(prd, ctx.prdPath, ctx.workdir);

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
