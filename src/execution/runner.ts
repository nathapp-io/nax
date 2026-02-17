/**
 * Execution Runner — The Core Loop
 *
 * Orchestrates the agent loop:
 * 1. Load PRD → find next story/batch
 * 2. Run pipeline for each story/batch
 * 3. Handle pipeline results (escalate, mark complete, etc.)
 * 4. Loop until complete or blocked
 */

import chalk from "chalk";
import type { NgentConfig } from "../config";
import { getAgent } from "../agents";
import { loadPRD, savePRD, getNextStory, isComplete, countStories, markStoryFailed } from "../prd";
import type { UserStory } from "../prd";
import { routeTask } from "../routing";
import { fireHook, type HooksConfig } from "../hooks";
import { precomputeBatchPlan, type StoryBatch } from "./batching";
import { escalateTier } from "./escalation";
import {
  hookCtx,
  getAllReadyStories,
  acquireLock,
  releaseLock,
  formatProgress,
} from "./helpers";
import { appendProgress } from "./progress";
import { runPipeline } from "../pipeline/runner";
import { defaultPipeline } from "../pipeline/stages";
import type { PipelineContext } from "../pipeline/types";

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
  const { prdPath, workdir, config, hooks, feature, featureDir, dryRun, useBatch = true } = options;
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
      } else {
        console.log(chalk.white(`   Story: ${story.id} — ${story.title}`));
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

      // Build pipeline context
      const pipelineContext: PipelineContext = {
        config,
        prd,
        story,
        stories: storiesToExecute,
        routing,
        workdir,
        featureDir,
        hooks,
      };

      // Run pipeline
      const pipelineResult = await runPipeline(defaultPipeline, pipelineContext);

      // Update PRD reference (pipeline may have modified it)
      prd = pipelineResult.context.prd;

      // Handle pipeline result
      if (pipelineResult.success) {
        // Pipeline completed successfully — stories marked as passed in completion stage
        storiesCompleted += storiesToExecute.length;
        totalCost += pipelineResult.context.agentResult?.estimatedCost || 0;
        prdDirty = true;

        // Display progress
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
      } else {
        // Pipeline stopped early — handle based on finalAction
        switch (pipelineResult.finalAction) {
          case "pause":
            await fireHook(hooks, "on-pause", hookCtx(feature, {
              storyId: story.id,
              reason: pipelineResult.reason || "Pipeline paused",
              cost: totalCost,
            }), workdir);
            return {
              success: false,
              iterations,
              storiesCompleted,
              totalCost,
              durationMs: Date.now() - startTime,
            };

          case "skip":
            // Story already marked as skipped in queue-check stage
            console.log(chalk.yellow(`   ⏭️  ${pipelineResult.reason}`));
            prdDirty = true;
            break;

          case "fail":
            // Mark first story as failed and stop
            markStoryFailed(prd, story.id);
            await savePRD(prd, prdPath);
            prdDirty = true;

            console.log(chalk.red(`   ✗ Story ${story.id} failed: ${pipelineResult.reason}`));

            if (featureDir) {
              await appendProgress(featureDir, story.id, "failed", `${story.title} — ${pipelineResult.reason}`);
            }

            await fireHook(hooks, "on-story-fail", hookCtx(feature, {
              storyId: story.id,
              status: "failed",
              reason: pipelineResult.reason || "Pipeline failed",
              cost: totalCost,
            }), workdir);

            break;

          case "escalate":
            // Escalate to next tier
            const nextTier = escalateTier(routing.modelTier, config.autoMode.escalation.tierOrder);
            const escalateWholeBatch = config.autoMode.escalation.escalateEntireBatch ?? true;
            const storiesToEscalate = isBatchExecution && escalateWholeBatch
              ? storiesToExecute
              : [story];

            if (nextTier && config.autoMode.escalation.enabled) {
              const canEscalate = storiesToEscalate.every(s => s.attempts < config.autoMode.escalation.maxAttempts);

              if (canEscalate) {
                for (const s of storiesToEscalate) {
                  console.log(chalk.yellow(`   ⬆️  Escalating ${s.id} to ${nextTier}`));
                }

                const errorMessage = `Attempt ${story.attempts + 1} failed with model tier: ${routing.modelTier}${isBatchExecution ? " (in batch)" : ""}`;

                prd.userStories = prd.userStories.map((s) => {
                  const shouldEscalate = storiesToEscalate.some(story => story.id === s.id);
                  return shouldEscalate
                    ? {
                        ...s,
                        attempts: s.attempts + 1,
                        routing: s.routing
                          ? { ...s.routing, modelTier: nextTier }
                          : undefined,
                        priorErrors: [...(s.priorErrors || []), errorMessage],
                      }
                    : s;
                });
                await savePRD(prd, prdPath);
                prdDirty = true;
              } else {
                // Max attempts reached — mark as failed
                markStoryFailed(prd, story.id);
                await savePRD(prd, prdPath);
                prdDirty = true;

                console.log(chalk.red(`   ✗ Story ${story.id} failed (max attempts reached)`));

                if (featureDir) {
                  await appendProgress(featureDir, story.id, "failed", `${story.title} — Max attempts reached`);
                }

                await fireHook(hooks, "on-story-fail", hookCtx(feature, {
                  storyId: story.id,
                  status: "failed",
                  reason: "Max attempts reached",
                  cost: totalCost,
                }), workdir);

                break;
              }
            } else {
              // No next tier or escalation disabled — mark as failed
              markStoryFailed(prd, story.id);
              await savePRD(prd, prdPath);
              prdDirty = true;

              console.log(chalk.red(`   ✗ Story ${story.id} failed`));

              if (featureDir) {
                await appendProgress(featureDir, story.id, "failed", `${story.title} — Execution failed`);
              }

              await fireHook(hooks, "on-story-fail", hookCtx(feature, {
                storyId: story.id,
                status: "failed",
                reason: "Execution failed",
                cost: totalCost,
              }), workdir);

              break;
            }
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
