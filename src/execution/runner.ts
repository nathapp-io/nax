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
import path from "node:path";
import type { NaxConfig } from "../config";
import { getAgent } from "../agents";
import { resolveModel } from "../config/schema";
import { loadPRD, savePRD, getNextStory, isComplete, countStories, markStoryFailed, isStalled, markStoryAsBlocked, generateHumanHaltSummary } from "../prd";
import type { UserStory } from "../prd";
import { routeTask } from "../routing";
import { fireHook, type HooksConfig } from "../hooks";
import { precomputeBatchPlan, type StoryBatch } from "./batching";
import { escalateTier, calculateMaxIterations, getTierConfig } from "./escalation";
import {
  hookCtx,
  getAllReadyStories,
  acquireLock,
  releaseLock,
  formatProgress,
} from "./helpers";
import { appendProgress } from "./progress";
import { runVerification, parseTestOutput } from "./verification";
import { runPipeline } from "../pipeline/runner";
import { defaultPipeline } from "../pipeline/stages";
import type { PipelineContext } from "../pipeline/types";
import {
  generateFixStories,
  convertFixStoryToUserStory,
} from "../acceptance";
import { saveRunMetrics, type StoryMetrics } from "../metrics";

/** Run options */
export interface RunOptions {
  /** Path to prd.json */
  prdPath: string;
  /** Working directory */
  workdir: string;
  /** Ngent config */
  config: NaxConfig;
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
  const runStartedAt = new Date().toISOString();
  const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  let iterations = 0;
  let storiesCompleted = 0;
  let totalCost = 0;
  const allStoryMetrics: StoryMetrics[] = [];
  // ADR-003: Track timeout retries per story for --detectOpenHandles escalation
  const timeoutRetryCountMap = new Map<string, number>();

  // Acquire lock to prevent concurrent execution
  const lockAcquired = await acquireLock(workdir);
  if (!lockAcquired) {
    console.error(chalk.red("❌ Another nax process is already running in this directory"));
    console.error(chalk.yellow("   If you believe this is an error, remove nax.lock manually"));
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

    console.log(chalk.cyan(`\n🚀 nax: Starting ${feature}`));
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
        storiesToExecute = batch.stories.filter(s => !s.passes && s.status !== "skipped" && s.status !== "blocked" && s.status !== "failed");
        isBatchExecution = batch.isBatch && storiesToExecute.length > 1;

        if (storiesToExecute.length === 0) {
          // All stories in this batch already completed, move to next batch
          continue;
        }

        // Use first story as the primary story for routing/context
        story = storiesToExecute[0];
        // Always derive routing from current config (modelTier not cached)
        routing = routeTask(
          story.title,
          story.description,
          story.acceptanceCriteria,
          story.tags,
          config,
        );
        // Override with cached complexity if available
        if (story.routing) {
          routing.complexity = story.routing.complexity;
          routing.testStrategy = story.routing.testStrategy;
        }
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

        // Always derive routing from current config (modelTier not cached)
        routing = routeTask(
          story.title,
          story.description,
          story.acceptanceCriteria,
          story.tags,
          config,
        );
        // Override with cached complexity if available
        if (story.routing) {
          routing.complexity = story.routing.complexity;
          routing.testStrategy = story.routing.testStrategy;
        }
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
      const storyStartTime = new Date().toISOString();
      const pipelineContext: PipelineContext = {
        config,
        prd,
        story,
        stories: storiesToExecute,
        routing,
        workdir,
        featureDir,
        hooks,
        storyStartTime,
      };

      // Run pipeline
      const pipelineResult = await runPipeline(defaultPipeline, pipelineContext);

      // Update PRD reference (pipeline may have modified it)
      prd = pipelineResult.context.prd;

      // Handle pipeline result
      if (pipelineResult.success) {
        // Pipeline completed successfully — stories marked as passed in completion stage
        totalCost += pipelineResult.context.agentResult?.estimatedCost || 0;
        prdDirty = true;

        // Collect story metrics (set by completionStage)
        if (pipelineResult.context.storyMetrics) {
          allStoryMetrics.push(...pipelineResult.context.storyMetrics);
        }

        // ADR-003: Post-agent verification (if quality.commands.test is configured)
        let verificationPassed = true;
        if (config.quality.commands.test) {
          console.log(chalk.dim(`   🔍 Running verification: ${config.quality.commands.test}`));

          const timeoutRetryCount = timeoutRetryCountMap.get(story.id) || 0;
          const verificationResult = await runVerification({
            workingDirectory: workdir,
            relevantFiles: story.relevantFiles,
            command: config.quality.commands.test,
            timeoutSeconds: config.execution.verificationTimeoutSeconds,
            forceExit: config.quality.forceExit,
            detectOpenHandles: config.quality.detectOpenHandles,
            detectOpenHandlesRetries: config.quality.detectOpenHandlesRetries,
            timeoutRetryCount,
            gracePeriodMs: config.quality.gracePeriodMs,
            drainTimeoutMs: config.quality.drainTimeoutMs,
            shell: config.quality.shell,
            stripEnvVars: config.quality.stripEnvVars,
          });

          if (!verificationResult.success) {
            verificationPassed = false;

            // BUG-1 fix: Undo story metrics added by completionStage since verification failed.
            // The completion stage marks stories as passed before verification runs.
            // TODO: Refactor verification into a pipeline stage to avoid this post-hoc revert.
            const storyIds = new Set(storiesToExecute.map(s => s.id));
            const metricsCountBefore = allStoryMetrics.length;
            for (let i = allStoryMetrics.length - 1; i >= 0; i--) {
              if (storyIds.has(allStoryMetrics[i].storyId)) {
                allStoryMetrics.splice(i, 1);
              }
            }

            // Track timeout retries for --detectOpenHandles escalation
            if (verificationResult.status === "TIMEOUT") {
              timeoutRetryCountMap.set(story.id, timeoutRetryCount + 1);
            }

            // Revert ALL stories in this batch/single back to pending (completionStage marked them passed)
            const diagnosticContext = verificationResult.error || `Verification failed: ${verificationResult.status}`;
            prd.userStories = prd.userStories.map(s =>
              storyIds.has(s.id)
                ? { ...s, priorErrors: [...(s.priorErrors || []), diagnosticContext], status: "pending" as const, passes: false }
                : s
            );

            console.log(chalk.yellow(`   ⚠️  Verification ${verificationResult.status}: ${verificationResult.error?.split("\n")[0]}`));

            if (verificationResult.output && verificationResult.passCount !== undefined) {
              console.log(chalk.dim(`   Tests: ${verificationResult.passCount} pass, ${verificationResult.failCount} fail`));
            }

            // Don't count toward escalation for timeouts (environmental issue)
            if (verificationResult.countsTowardEscalation) {
              // Increment attempts — this drives tier escalation
              prd.userStories = prd.userStories.map(s =>
                s.id === story.id ? { ...s, attempts: s.attempts + 1 } : s
              );
            }

            await savePRD(prd, prdPath);

            if (featureDir) {
              await appendProgress(featureDir, story.id, "verification-failed",
                `${story.title} — ${verificationResult.status}: ${verificationResult.error?.split("\n")[0]}`);
            }
          } else {
            console.log(chalk.green(`   ✓ Verification passed`));
            if (verificationResult.output) {
              const analysis = parseTestOutput(verificationResult.output!, 0);
              if (analysis.passCount > 0) {
                console.log(chalk.dim(`   Tests: ${analysis.passCount} pass, ${analysis.failCount} fail`));
              }
            }
          }
        }

        if (verificationPassed) {
          storiesCompleted += storiesToExecute.length;
        }

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
              const maxAttempts = calculateMaxIterations(config.autoMode.escalation.tierOrder);
              const canEscalate = storiesToEscalate.every(s => s.attempts < maxAttempts);

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

      // ADR-003: Stall detection — all remaining stories blocked or dependent on blocked
      if (prdDirty) {
        prd = await loadPRD(prdPath);
        prdDirty = false;
      }
      if (isStalled(prd)) {
        const summary = generateHumanHaltSummary(prd);
        console.log(chalk.red(`\n${summary}`));
        await fireHook(hooks, "on-pause", hookCtx(feature, {
          reason: "All remaining stories blocked or dependent on blocked stories",
          cost: totalCost,
        }), workdir);
        break;
      }

      // Delay between iterations
      if (config.execution.iterationDelayMs > 0) {
        await Bun.sleep(config.execution.iterationDelayMs);
      }
    }

    // After main loop: Check if we need acceptance retry loop
    if (config.acceptance.enabled && isComplete(prd)) {
      console.log(chalk.cyan("\n🔄 All stories complete — running acceptance validation..."));

      let acceptanceRetries = 0;
      const maxRetries = config.acceptance.maxRetries;

      while (acceptanceRetries < maxRetries) {
        // Build context for acceptance stage only
        const firstStory = prd.userStories[0]; // Use first story as placeholder
        const acceptanceContext: PipelineContext = {
          config,
          prd,
          story: firstStory,
          stories: [firstStory],
          routing: {
            complexity: "simple",
            modelTier: "balanced",
            testStrategy: "test-after",
            reasoning: "Acceptance validation",
          },
          workdir,
          featureDir,
          hooks,
        };

        // Run acceptance stage
        const { acceptanceStage } = await import("../pipeline/stages/acceptance");
        const acceptanceResult = await acceptanceStage.execute(acceptanceContext);

        if (acceptanceResult.action === "continue") {
          // All acceptance tests passed
          console.log(chalk.green("\n✅ Acceptance validation passed!"));
          break;
        }

        // Acceptance tests failed
        if (acceptanceResult.action === "fail") {
          const failures = acceptanceContext.acceptanceFailures;

          if (!failures || failures.failedACs.length === 0) {
            console.log(chalk.red("\n❌ Acceptance tests failed but no specific failures detected"));
            console.log(chalk.yellow("   Manual intervention required"));
            await fireHook(hooks, "on-pause", hookCtx(feature, {
              reason: "Acceptance tests failed (no failures detected)",
              cost: totalCost,
            }), workdir);
            break;
          }

          acceptanceRetries++;
          console.log(chalk.yellow(`\n⚠️  Acceptance retry ${acceptanceRetries}/${maxRetries}`));
          console.log(chalk.yellow(`   Failed ACs: ${failures.failedACs.join(", ")}`));

          if (acceptanceRetries >= maxRetries) {
            console.log(chalk.red("\n❌ Max acceptance retries reached"));
            console.log(chalk.yellow("   Manual intervention required"));
            console.log(chalk.dim("   Run: nax accept --override AC-N \"reason\" to skip specific ACs"));
            await fireHook(hooks, "on-pause", hookCtx(feature, {
              reason: `Acceptance validation failed after ${maxRetries} retries: ${failures.failedACs.join(", ")}`,
              cost: totalCost,
            }), workdir);
            break;
          }

          // Generate fix stories
          console.log(chalk.cyan("\n🔧 Generating fix stories..."));

          // Load spec.md for AC text
          let specContent = "";
          if (featureDir) {
            const specPath = path.join(featureDir, "spec.md");
            const specFile = Bun.file(specPath);
            if (await specFile.exists()) {
              specContent = await specFile.text();
            }
          }

          const agent = getAgent(config.autoMode.defaultAgent);
          if (!agent) {
            console.error(chalk.red("❌ Agent not found — cannot generate fix stories"));
            break;
          }

          const modelTier = config.analyze.model;
          const modelEntry = config.models[modelTier];
          const modelDef = resolveModel(modelEntry);

          const fixStories = await generateFixStories(agent, {
            failedACs: failures.failedACs,
            testOutput: failures.testOutput,
            prd,
            specContent,
            workdir,
            modelDef,
          });

          if (fixStories.length === 0) {
            console.log(chalk.red("\n❌ Failed to generate fix stories"));
            break;
          }

          console.log(chalk.green(`\n✓ Generated ${fixStories.length} fix stories`));

          // Append fix stories to PRD
          for (const fixStory of fixStories) {
            const userStory = convertFixStoryToUserStory(fixStory);
            prd.userStories.push(userStory);
            console.log(chalk.dim(`   ${userStory.id}: ${userStory.title}`));
          }

          await savePRD(prd, prdPath);
          prdDirty = true;

          // Re-run pipeline for fix stories only
          console.log(chalk.cyan("\n🔄 Running fix stories..."));

          for (const fixStory of fixStories) {
            const userStory = prd.userStories.find(s => s.id === fixStory.id);
            if (!userStory || userStory.status !== "pending") continue;

            iterations++;

            const routing = routeTask(
              userStory.title,
              userStory.description,
              userStory.acceptanceCriteria,
              userStory.tags,
              config,
            );

            console.log(chalk.cyan(`\n── Fix Story: ${userStory.id} ──────────────────────`));
            console.log(chalk.white(`   ${userStory.title}`));

            await fireHook(hooks, "on-story-start", hookCtx(feature, {
              storyId: userStory.id,
              model: routing.modelTier,
              agent: config.autoMode.defaultAgent,
              iteration: iterations,
            }), workdir);

            const fixStoryStartTime = new Date().toISOString();
            const fixContext: PipelineContext = {
              config,
              prd,
              story: userStory,
              stories: [userStory],
              routing,
              workdir,
              featureDir,
              hooks,
              storyStartTime: fixStoryStartTime,
            };

            const fixResult = await runPipeline(defaultPipeline, fixContext);
            prd = fixResult.context.prd;

            if (fixResult.success) {
              storiesCompleted++;
              totalCost += fixResult.context.agentResult?.estimatedCost || 0;
              console.log(chalk.green(`   ✓ Fix story ${userStory.id} passed`));

              // Collect fix story metrics
              if (fixResult.context.storyMetrics) {
                allStoryMetrics.push(...fixResult.context.storyMetrics);
              }
            } else {
              console.log(chalk.red(`   ✗ Fix story ${userStory.id} failed`));
            }

            await savePRD(prd, prdPath);
            prdDirty = true;
          }

          console.log(chalk.cyan("\n🔄 Re-running acceptance tests..."));
          // Loop will re-run acceptance tests
        } else {
          // Unexpected result from acceptance stage
          console.log(chalk.yellow(`\n⚠️  Unexpected acceptance result: ${acceptanceResult.action}`));
          break;
        }
      }
    }

    const durationMs = Date.now() - startTime;

    // Save run metrics
    const runCompletedAt = new Date().toISOString();
    const runMetrics = {
      runId,
      feature,
      startedAt: runStartedAt,
      completedAt: runCompletedAt,
      totalCost,
      totalStories: allStoryMetrics.length,
      storiesCompleted,
      storiesFailed: countStories(prd).failed,
      totalDurationMs: durationMs,
      stories: allStoryMetrics,
    };

    await saveRunMetrics(workdir, runMetrics);

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
