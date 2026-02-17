/**
 * Execution Runner — The Core Loop
 *
 * Orchestrates the agent loop:
 * 1. Load PRD → find next story
 * 2. Route (complexity → model tier + test strategy)
 * 3. Spawn agent session(s)
 * 4. Verify → mark done or escalate
 * 5. Loop until complete or blocked
 */

import chalk from "chalk";
import type { NgentConfig } from "../config";
import { resolveModel } from "../config";
import { getAgent } from "../agents";
import { loadPRD, savePRD, getNextStory, isComplete, countStories, markStoryPassed, markStoryFailed, markStorySkipped } from "../prd";
import type { UserStory } from "../prd";
import { routeTask } from "../routing";
import { fireHook, type HooksConfig } from "../hooks";
import { runThreeSessionTdd } from "../tdd";
import { appendProgress } from "./progress";
import { buildSingleSessionPrompt, buildBatchPrompt } from "./prompts";
import { groupStoriesIntoBatches, precomputeBatchPlan, type StoryBatch } from "./batching";
import { escalateTier } from "./escalation";
import { readQueueFile, clearQueueFile } from "./queue-handler";
import {
  hookCtx,
  maybeGetContext,
  getAllReadyStories,
  acquireLock,
  releaseLock,
  formatProgress,
} from "./helpers";

/** Run options */
export interface RunOptions {
  /** Path to prd.json */
  prdPath: string;
  /** Working directory */
  workdir: string;
  /** Ngent config */
  config: NgentConfig;
  /** Hooks config */
  hooks: HooksConfig;
  /** Feature name */
  feature: string;
  /** Feature directory (for progress logging) */
  featureDir?: string;
  /** Dry run */
  dryRun: boolean;
  /** Use context builder (default: true) */
  useContext?: boolean;
  /** Enable story batching (default: true) */
  useBatch?: boolean;
}

/** Run result */
export interface RunResult {
  success: boolean;
  iterations: number;
  storiesCompleted: number;
  totalCost: number;
  durationMs: number;
}

/**
 * Main execution loop
 */
export async function run(options: RunOptions): Promise<RunResult> {
  const { prdPath, workdir, config, hooks, feature, featureDir, dryRun, useContext = true, useBatch = true } = options;
  const startTime = Date.now();
  let iterations = 0;
  let storiesCompleted = 0;
  let totalCost = 0;

  // Acquire lock to prevent concurrent execution
  const lockAcquired = await acquireLock(workdir);
  if (!lockAcquired) {
    console.error(chalk.red("❌ Another ngent process is already running in this directory"));
    console.error(chalk.yellow("   If you believe this is an error, remove ngent.lock manually"));
    process.exit(1);
  }

  try {
    // Fire on-start hook
    await fireHook(hooks, "on-start", hookCtx(feature), workdir);

  // Check agent installation before starting
  const agent = getAgent(config.autoMode.defaultAgent);
  if (!agent) {
    console.error(chalk.red(`Agent "${config.autoMode.defaultAgent}" not found`));
    process.exit(1);
  }

  const installed = await agent.isInstalled();
  if (!installed) {
    console.error(chalk.red(`Agent "${config.autoMode.defaultAgent}" (${agent.binary}) is not installed or not in PATH`));
    console.error(chalk.yellow(`Please install the agent and try again.`));
    process.exit(1);
  }

  // Load PRD
  let prd = await loadPRD(prdPath);
  let prdDirty = false; // Track if PRD needs reloading
  const counts = countStories(prd);

  // MEM-1: Validate story count doesn't exceed limit
  if (counts.total > config.execution.maxStoriesPerFeature) {
    console.error(chalk.red(`❌ Feature has ${counts.total} stories, exceeding limit of ${config.execution.maxStoriesPerFeature}`));
    console.error(chalk.yellow("   Split this feature into smaller features or increase maxStoriesPerFeature in config."));
    process.exit(1);
  }

  console.log(chalk.cyan(`\n🚀 ngent: Starting ${feature}`));
  console.log(chalk.dim(`   Stories: ${counts.total} (${counts.passed} done, ${counts.pending} pending)`));
  if (useBatch) {
    console.log(chalk.dim(`   Batching: enabled (groups consecutive simple stories, max 4/batch)`));
  }

  // PERF-1: Precompute batch plan once from ready stories
  let batchPlan: StoryBatch[] = [];
  let currentBatchIndex = 0;
  if (useBatch) {
    const readyStories = getAllReadyStories(prd);
    batchPlan = precomputeBatchPlan(readyStories, 4);
  }

  // Main loop
  while (iterations < config.execution.maxIterations) {
    iterations++;

    // MEM-1: Check memory usage (warn if > 1GB heap)
    const memUsage = process.memoryUsage();
    const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
    if (heapUsedMB > 1024) {
      console.log(chalk.yellow(`\n⚠️  High memory usage: ${heapUsedMB} MB`));
      console.log(chalk.yellow("   Consider pausing (echo PAUSE > .queue.txt) if this continues to grow"));
    }

    // Reload PRD only if dirty (modified since last load)
    if (prdDirty) {
      prd = await loadPRD(prdPath);
      prdDirty = false;

      // PERF-1: Recompute batch plan after PRD reload
      if (useBatch) {
        const readyStories = getAllReadyStories(prd);
        batchPlan = precomputeBatchPlan(readyStories, 4);
        currentBatchIndex = 0;
      }
    }

    // Check completion
    if (isComplete(prd)) {
      console.log(chalk.green.bold("\n✅ All stories complete!"));
      await fireHook(hooks, "on-complete", hookCtx(feature, { status: "complete", cost: totalCost }), workdir);
      break;
    }

    // PERF-1: Use precomputed batch plan instead of recomputing batches each iteration
    let storiesToExecute: UserStory[];
    let isBatchExecution: boolean;
    let story: UserStory;
    let routing: ReturnType<typeof routeTask>;

    if (useBatch && currentBatchIndex < batchPlan.length) {
      // Get next batch from precomputed plan
      const batch = batchPlan[currentBatchIndex];
      currentBatchIndex++;

      // Filter out already-completed stories (may have been completed in previous iteration)
      storiesToExecute = batch.stories.filter(s => !s.passes && s.status !== "skipped");
      isBatchExecution = batch.isBatch && storiesToExecute.length > 1;

      if (storiesToExecute.length === 0) {
        // All stories in this batch already completed, move to next batch
        continue;
      }

      // Use first story as the primary story for routing/context
      story = storiesToExecute[0];
      routing = story.routing || routeTask(
        story.title,
        story.description,
        story.acceptanceCriteria,
        story.tags,
        config,
      );
    } else {
      // Fallback to single-story mode (when batching disabled or batch plan exhausted)
      const nextStory = getNextStory(prd);
      if (!nextStory) {
        console.log(chalk.yellow("\n⚠️  No actionable stories (check dependencies)"));
        break;
      }

      story = nextStory;
      storiesToExecute = [story];
      isBatchExecution = false;

      routing = story.routing || routeTask(
        story.title,
        story.description,
        story.acceptanceCriteria,
        story.tags,
        config,
      );
    }

    // Check queue file for commands BEFORE executing batch
    const queueCommands = await readQueueFile(workdir);
    let skippedAnyStory = false;

    for (const cmd of queueCommands) {
      if (cmd.type === "PAUSE") {
        console.log(chalk.yellow("\n⏸️  Paused by user (PAUSE command in .queue.txt)"));
        await clearQueueFile(workdir);
        await fireHook(hooks, "on-pause", hookCtx(feature, {
          storyId: story.id,
          reason: "User requested pause via .queue.txt",
          cost: totalCost,
        }), workdir);
        return {
          success: false,
          iterations,
          storiesCompleted,
          totalCost,
          durationMs: Date.now() - startTime,
        };
      } else if (cmd.type === "ABORT") {
        console.log(chalk.yellow("\n🛑 Aborting: marking remaining stories as skipped"));

        // Mark all pending stories as skipped
        prd.userStories.forEach((s) => {
          if (s.status === "pending") {
            markStorySkipped(prd, s.id);
          }
        });
        await savePRD(prd, prdPath);
        prdDirty = true;
        await clearQueueFile(workdir);

        return {
          success: false,
          iterations,
          storiesCompleted,
          totalCost,
          durationMs: Date.now() - startTime,
        };
      } else if (cmd.type === "SKIP") {
        // Filter out skipped story from batch
        const storyIndex = storiesToExecute.findIndex((s) => s.id === cmd.storyId);
        if (storyIndex !== -1) {
          console.log(chalk.yellow(`   ⏭️  Skipping story ${cmd.storyId} by user request (removing from batch)`));
          storiesToExecute.splice(storyIndex, 1);
          markStorySkipped(prd, cmd.storyId);
          skippedAnyStory = true;
        } else {
          // Story not in current batch, but might be in PRD
          const prdStory = prd.userStories.find((s) => s.id === cmd.storyId);
          if (prdStory && prdStory.status === "pending") {
            console.log(chalk.yellow(`   ⏭️  Skipping story ${cmd.storyId} by user request`));
            markStorySkipped(prd, cmd.storyId);
            skippedAnyStory = true;
          }
        }
      }
    }

    // Save PRD if any stories were skipped
    if (skippedAnyStory) {
      await savePRD(prd, prdPath);
      prdDirty = true;
    }

    // Clear processed commands
    if (queueCommands.length > 0) {
      await clearQueueFile(workdir);
    }

    // If all stories in batch were skipped, continue to next iteration
    if (storiesToExecute.length === 0) {
      console.log(chalk.yellow("   ⏭️  All stories in batch were skipped, continuing to next iteration"));
      continue;
    }

    // Re-check if this is still a batch after filtering
    if (isBatchExecution && storiesToExecute.length === 1) {
      isBatchExecution = false;
    }

    // Check cost limit
    if (totalCost >= config.execution.costLimit) {
      console.log(chalk.yellow(`\n⏸  Cost limit reached ($${totalCost.toFixed(2)} >= $${config.execution.costLimit})`));
      await fireHook(hooks, "on-pause", hookCtx(feature, {
        storyId: story.id,
        reason: `Cost limit reached: $${totalCost.toFixed(2)}`,
        cost: totalCost,
      }), workdir);
      break;
    }

    console.log(chalk.cyan(`\n── Iteration ${iterations} ──────────────────────`));
    if (isBatchExecution) {
      console.log(chalk.white(`   Batch: ${storiesToExecute.length} stories (${storiesToExecute.map(s => s.id).join(", ")})`));
      console.log(chalk.dim(`   Complexity: ${routing.complexity} | Model: ${routing.modelTier} | TDD: ${routing.testStrategy}`));
    } else {
      console.log(chalk.white(`   Story: ${story.id} — ${story.title}`));
      console.log(chalk.dim(`   Complexity: ${routing.complexity} | Model: ${routing.modelTier} | TDD: ${routing.testStrategy}`));
      console.log(chalk.dim(`   Routing: ${routing.reasoning}`));
    }

    // Fire story-start hook
    await fireHook(hooks, "on-story-start", hookCtx(feature, {
      storyId: story.id,
      model: routing.modelTier,
      agent: config.autoMode.defaultAgent,
      iteration: iterations,
    }), workdir);

    if (dryRun) {
      console.log(chalk.yellow("   [DRY RUN] Would execute agent here"));
      continue;
    }

    // Execute based on test strategy
    let sessionSuccess = false;
    let sessionCost = 0;

    if (routing.testStrategy === "three-session-tdd") {
      // Three-session TDD: test-writer → implementer → verifier
      const contextMarkdown = await maybeGetContext(prd, story, config, useContext);

      const tddResult = await runThreeSessionTdd(
        agent,
        story,
        config,
        workdir,
        routing.modelTier,
        contextMarkdown,
        dryRun,
      );

      sessionSuccess = tddResult.success && !tddResult.needsHumanReview;
      sessionCost = tddResult.totalCost;

      if (tddResult.needsHumanReview) {
        console.log(chalk.yellow(`\n⏸  Human review needed: ${tddResult.reviewReason}`));
        await fireHook(hooks, "on-pause", hookCtx(feature, {
          storyId: story.id,
          reason: tddResult.reviewReason || "Three-session TDD requires review",
          cost: totalCost + sessionCost,
        }), workdir);
        break;
      }
    } else {
      // test-after: single or batch agent session
      const contextMarkdown = await maybeGetContext(prd, story, config, useContext);

      const prompt = isBatchExecution
        ? buildBatchPrompt(storiesToExecute, contextMarkdown)
        : buildSingleSessionPrompt(story, contextMarkdown);

      if (isBatchExecution) {
        console.log(chalk.cyan(`\n   → Batch session (${storiesToExecute.length} stories, test-after)`));
      } else {
        console.log(chalk.cyan(`\n   → Single session (test-after)`));
      }

      const result = await agent.run({
        prompt,
        workdir,
        modelTier: routing.modelTier,
        modelDef: resolveModel(config.models[routing.modelTier]),
        timeoutSeconds: config.execution.sessionTimeoutSeconds,
      });

      sessionSuccess = result.success;
      sessionCost = result.estimatedCost;

      if (!result.success) {
        console.log(chalk.red(`   ✗ Agent session failed`));
        if (result.rateLimited) {
          console.log(chalk.yellow(`   ⚠️  Rate limited — will retry`));
        }
      } else {
        console.log(chalk.green(`   ✓ Agent session complete`));
      }
    }

    // Update total cost
    totalCost += sessionCost;

    // Update PRD based on success
    if (sessionSuccess) {
      // Mark all stories in the batch/single as passed
      for (const completedStory of storiesToExecute) {
        markStoryPassed(prd, completedStory.id);
        storiesCompleted++;

        console.log(chalk.green(`   ✓ Story ${completedStory.id} passed`));

        // Log progress
        if (featureDir) {
          const costPerStory = sessionCost / storiesToExecute.length;
          await appendProgress(
            featureDir,
            completedStory.id,
            "passed",
            `${completedStory.title} — Cost: $${costPerStory.toFixed(4)}${isBatchExecution ? " (batched)" : ""}`,
          );
        }

        // Fire story-complete hook
        await fireHook(hooks, "on-story-complete", hookCtx(feature, {
          storyId: completedStory.id,
          status: "passed",
          cost: sessionCost / storiesToExecute.length,
        }), workdir);
      }

      await savePRD(prd, prdPath);
      prdDirty = true;

      // Display progress after story completion
      const updatedCounts = countStories(prd);
      const elapsedMs = Date.now() - startTime;
      const progressLine = formatProgress(
        {
          total: updatedCounts.total,
          passed: updatedCounts.passed,
          failed: updatedCounts.failed,
          pending: updatedCounts.pending,
        },
        totalCost,
        config.execution.costLimit,
        elapsedMs,
        updatedCounts.total,
      );
      console.log(chalk.cyan(`\n${progressLine}`));

      // Check queue file for commands after story completion
      const queueCommands = await readQueueFile(workdir);

      for (const cmd of queueCommands) {
        if (cmd.type === "PAUSE") {
          console.log(chalk.yellow("\n⏸️  Paused by user (PAUSE command in .queue.txt)"));
          await clearQueueFile(workdir);
          await fireHook(hooks, "on-pause", hookCtx(feature, {
            storyId: story.id,
            reason: "User requested pause via .queue.txt",
            cost: totalCost,
          }), workdir);
          return {
            success: false,
            iterations,
            storiesCompleted,
            totalCost,
            durationMs: Date.now() - startTime,
          };
        } else if (cmd.type === "ABORT") {
          console.log(chalk.yellow("\n🛑 Aborting: marking remaining stories as skipped"));

          // Mark all pending stories as skipped
          prd.userStories.forEach((s) => {
            if (s.status === "pending") {
              markStorySkipped(prd, s.id);
            }
          });
          await savePRD(prd, prdPath);
          prdDirty = true;
          await clearQueueFile(workdir);

          return {
            success: false,
            iterations,
            storiesCompleted,
            totalCost,
            durationMs: Date.now() - startTime,
          };
        } else if (cmd.type === "SKIP") {
          console.log(chalk.yellow(`   ⏭️  Skipping story ${cmd.storyId} by user request`));
          markStorySkipped(prd, cmd.storyId);
          await savePRD(prd, prdPath);
          prdDirty = true;
        }
      }

      // Clear processed commands
      if (queueCommands.length > 0) {
        await clearQueueFile(workdir);
      }
    } else {
      // Handle failure — either escalate or mark failed
      //
      // BATCH FAILURE STRATEGY (Option B: Individual Retry at Same Tier First)
      // ========================================================================
      // When a batch execution fails (e.g., batch [US-001, US-002, US-003, US-004] on 'fast' tier),
      // we use a conservative escalation approach:
      //
      // 1. Only the FIRST story in the batch gets escalation treatment
      //    - If escalation is enabled and attempts < maxAttempts, first story escalates to next tier
      //    - Otherwise, first story is marked as failed
      //
      // 2. Remaining stories (2-4) remain at their CURRENT tier and status
      //    - They return to "pending" status (not included in this batch's processing)
      //    - They will be retried INDIVIDUALLY on the next iteration at the SAME tier
      //    - If individual retry fails, they THEN escalate according to normal escalation rules
      //
      // RATIONALE:
      // - Batch failures are often due to a single problematic story, not all stories
      // - Retrying individually at the same tier first avoids premature escalation
      // - This approach minimizes cost (doesn't escalate entire batch unnecessarily)
      // - Individual retries provide better error isolation and debugging
      //
      // ALTERNATIVE CONSIDERED (Option A: Escalate Entire Batch Together)
      // - Would escalate all stories in batch to next tier immediately
      // - More conservative but potentially wasteful if only one story was problematic
      // - Not implemented in current version
      //
      // FUTURE ENHANCEMENT:
      // - Add config option: `batch.escalateEntireBatchOnFailure: boolean`
      // - Default to current behavior (Option B), allow users to opt into Option A
      //
      const failedStory = storiesToExecute[0];
      const nextTier = escalateTier(routing.modelTier, config.autoMode.escalation.tierOrder);

      if (isBatchExecution) {
        console.log(chalk.yellow(`   ⚠️  Batch execution failed — will retry stories individually at same tier first`));
      }

      if (nextTier && config.autoMode.escalation.enabled && failedStory.attempts < config.autoMode.escalation.maxAttempts) {
        console.log(chalk.yellow(`   ⬆️  Escalating ${failedStory.id} to ${nextTier}`));

        // Capture failure reason for context
        const errorMessage = `Attempt ${failedStory.attempts + 1} failed with model tier: ${routing.modelTier}${isBatchExecution ? " (in batch)" : ""}`;

        // Update PRD with escalation (not marking as failed yet)
        prd.userStories = prd.userStories.map((s) =>
          s.id === failedStory.id
            ? {
                ...s,
                attempts: s.attempts + 1,
                routing: s.routing
                  ? { ...s.routing, modelTier: nextTier }
                  : undefined,
                priorErrors: [...(s.priorErrors || []), errorMessage],
              }
            : s,
        );
        await savePRD(prd, prdPath);
        prdDirty = true;
      } else {
        markStoryFailed(prd, failedStory.id);
        await savePRD(prd, prdPath);
        prdDirty = true;

        console.log(chalk.red(`   ✗ Story ${failedStory.id} failed`));

        // Log progress
        if (featureDir) {
          await appendProgress(featureDir, failedStory.id, "failed", `${failedStory.title} — Agent execution failed`);
        }

        await fireHook(hooks, "on-story-fail", hookCtx(feature, {
          storyId: failedStory.id,
          status: "failed",
          reason: "Agent execution failed",
          cost: totalCost,
        }), workdir);

        // Stop on failure if not escalating
        break;
      }
    }

    // Delay between iterations
    if (config.execution.iterationDelayMs > 0) {
      await Bun.sleep(config.execution.iterationDelayMs);
    }
  }

  const durationMs = Date.now() - startTime;

  return {
    success: isComplete(prd),
    iterations,
    storiesCompleted,
    totalCost,
    durationMs,
  };
  } finally {
    // Always release lock, even if execution fails
    await releaseLock(workdir);
  }
}

// Re-exports for backward compatibility with existing test imports
export { buildSingleSessionPrompt, buildBatchPrompt } from "./prompts";
export { groupStoriesIntoBatches, type StoryBatch } from "./batching";
export { escalateTier } from "./escalation";
