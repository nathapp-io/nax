/**
 * Execution Runner — The Core Loop
 *
 * Orchestrates the agent loop:
 * 1. Load PRD → find next story/batch
 * 2. Run pipeline for each story/batch
 * 3. Handle pipeline results (escalate, mark complete, etc.)
 * 4. Loop until complete or blocked
 */

import * as os from "node:os";
import path from "node:path";
import { convertFixStoryToUserStory, generateFixStories } from "../acceptance";
import { getAgent } from "../agents";
import type { ModelTier, NaxConfig } from "../config";
import { resolveModel } from "../config/schema";
import { type LoadedHooksConfig, fireHook } from "../hooks";
import { getLogger } from "../logger";
import { type StoryMetrics, saveRunMetrics } from "../metrics";
import type { PipelineEventEmitter } from "../pipeline/events";
import { runPipeline } from "../pipeline/runner";
import { defaultPipeline } from "../pipeline/stages";
import type { PipelineContext, RoutingResult } from "../pipeline/types";
import { loadPlugins } from "../plugins/loader";
import type { PluginRegistry } from "../plugins/registry";
import {
  countStories,
  generateHumanHaltSummary,
  getNextStory,
  isComplete,
  isStalled,
  loadPRD,
  markStoryAsBlocked,
  markStoryFailed,
  markStoryPaused,
  savePRD,
} from "../prd";
import type { UserStory } from "../prd";
import { routeTask } from "../routing";
import { clearCache as clearLlmCache, routeBatch as llmRouteBatch } from "../routing/strategies/llm";
import { type StoryBatch, precomputeBatchPlan } from "./batching";
import { calculateMaxIterations, escalateTier, getTierConfig } from "./escalation";
import { acquireLock, formatProgress, getAllReadyStories, hookCtx, releaseLock } from "./helpers";
import { captureGitRef, runPostAgentVerification } from "./post-verify";
import { appendProgress } from "./progress";

/** Run options */

/**
 * Safely get logger instance, returns null if not initialized
 */
function getSafeLogger() {
  try {
    return getLogger();
  } catch {
    return null;
  }
}

/**
 * Try LLM batch routing for ready stories. Logs and swallows errors (falls back to per-story routing).
 */
async function tryLlmBatchRoute(config: NaxConfig, stories: UserStory[], label = "routing"): Promise<void> {
  const mode = config.routing.llm?.mode ?? "hybrid";
  if (config.routing.strategy !== "llm" || mode === "per-story" || stories.length === 0) return;
  const logger = getSafeLogger();
  try {
    logger?.debug("routing", `LLM batch routing: ${label}`, { storyCount: stories.length, mode });
    await llmRouteBatch(stories, { config });
    logger?.debug("routing", "LLM batch routing complete", { label });
  } catch (err) {
    logger?.warn("routing", "LLM batch routing failed, falling back to individual routing", {
      error: (err as Error).message,
      label,
    });
  }
}

/**
 * Apply cached routing overrides from story.routing to a fresh routing decision.
 */
function applyCachedRouting(
  routing: ReturnType<typeof routeTask>,
  story: UserStory,
  config: NaxConfig,
): ReturnType<typeof routeTask> {
  if (!story.routing) return routing;
  const overrides: Partial<ReturnType<typeof routeTask>> = {};
  if (story.routing.complexity) {
    overrides.complexity = story.routing.complexity;
    overrides.modelTier = (config.autoMode.complexityRouting[story.routing.complexity] ?? "balanced") as ModelTier;
  }
  if (story.routing.testStrategy) {
    overrides.testStrategy = story.routing.testStrategy;
  }
  return { ...routing, ...overrides };
}

export interface RunOptions {
  /** Path to prd.json */
  prdPath: string;
  /** Working directory */
  workdir: string;
  /** Ngent config */
  config: NaxConfig;
  /** Hooks config */
  hooks: LoadedHooksConfig;
  /** Feature name */
  feature: string;
  /** Feature directory (for progress logging) */
  featureDir?: string;
  /** Dry run */
  dryRun: boolean;
  /** Enable story batching (default: true) */
  useBatch?: boolean;
  /** Optional event emitter for TUI integration */
  eventEmitter?: PipelineEventEmitter;
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
  const { prdPath, workdir, config, hooks, feature, featureDir, dryRun, useBatch = true, eventEmitter } = options;
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
  const logger = getSafeLogger();
  const lockAcquired = await acquireLock(workdir);
  if (!lockAcquired) {
    logger?.error("execution", "Another nax process is already running in this directory");
    logger?.error("execution", "If you believe this is an error, remove nax.lock manually");
    process.exit(1);
  }

  // Load plugins (before try block so it's accessible in finally)
  const globalPluginsDir = path.join(os.homedir(), ".nax", "plugins");
  const projectPluginsDir = path.join(workdir, "nax", "plugins");
  const configPlugins = config.plugins || [];
  const pluginRegistry = await loadPlugins(globalPluginsDir, projectPluginsDir, configPlugins);
  const reporters = pluginRegistry.getReporters();

  try {
    logger?.info("plugins", `Loaded ${pluginRegistry.plugins.length} plugins`, {
      plugins: pluginRegistry.plugins.map((p) => ({ name: p.name, version: p.version, provides: p.provides })),
    });

    // Log run start
    const routingMode = config.routing.llm?.mode ?? "hybrid";
    logger?.info("run.start", `Starting feature: ${feature}`, {
      runId,
      feature,
      workdir,
      dryRun,
      useBatch,
      routingMode,
    });

    // Fire on-start hook
    await fireHook(hooks, "on-start", hookCtx(feature), workdir);

    // Check agent installation before starting
    const agent = getAgent(config.autoMode.defaultAgent);
    if (!agent) {
      logger?.error("execution", "Agent not found", {
        agent: config.autoMode.defaultAgent,
      });
      process.exit(1);
    }

    const installed = await agent.isInstalled();
    if (!installed) {
      logger?.error("execution", "Agent is not installed or not in PATH", {
        agent: config.autoMode.defaultAgent,
        binary: agent.binary,
      });
      logger?.error("execution", "Please install the agent and try again");
      process.exit(1);
    }

    // Load PRD
    let prd = await loadPRD(prdPath);
    let prdDirty = false; // Track if PRD needs reloading
    const counts = countStories(prd);

    // Update reporters with correct totalStories count
    for (const reporter of reporters) {
      if (reporter.onRunStart) {
        try {
          await reporter.onRunStart({
            runId,
            feature,
            totalStories: counts.total,
            startTime: runStartedAt,
          });
        } catch (error) {
          logger?.warn("plugins", `Reporter '${reporter.name}' onRunStart failed`, { error });
        }
      }
    }

    // MEM-1: Validate story count doesn't exceed limit
    if (counts.total > config.execution.maxStoriesPerFeature) {
      logger?.error("execution", "Feature exceeds story limit", {
        totalStories: counts.total,
        limit: config.execution.maxStoriesPerFeature,
      });
      logger?.error("execution", "Split this feature into smaller features or increase maxStoriesPerFeature in config");
      process.exit(1);
    }

    logger?.info("execution", `Starting ${feature}`, {
      totalStories: counts.total,
      doneStories: counts.passed,
      pendingStories: counts.pending,
      batchingEnabled: useBatch,
    });

    // Clear LLM routing cache at start of new run
    clearLlmCache();

    // PERF-1: Precompute batch plan once from ready stories
    let batchPlan: StoryBatch[] = [];
    let currentBatchIndex = 0;
    if (useBatch) {
      const readyStories = getAllReadyStories(prd);
      batchPlan = precomputeBatchPlan(readyStories, 4);

      await tryLlmBatchRoute(config, readyStories, "routing");
    }

    // Main loop
    while (iterations < config.execution.maxIterations) {
      iterations++;

      // MEM-1: Check memory usage (warn if > 1GB heap)
      const memUsage = process.memoryUsage();
      const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
      if (heapUsedMB > 1024) {
        logger?.warn("execution", "High memory usage detected", {
          heapUsedMB,
          suggestion: "Consider pausing (echo PAUSE > .queue.txt) if this continues to grow",
        });
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

          await tryLlmBatchRoute(config, readyStories, "re-routing");
        }
      }

      // Check completion
      if (isComplete(prd)) {
        logger?.info("execution", "All stories complete!", {
          feature,
          totalCost,
        });
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
        storiesToExecute = batch.stories.filter(
          (s) => !s.passes && s.status !== "skipped" && s.status !== "blocked" && s.status !== "failed" && s.status !== "paused",
        );
        isBatchExecution = batch.isBatch && storiesToExecute.length > 1;

        if (storiesToExecute.length === 0) {
          // All stories in this batch already completed, move to next batch
          continue;
        }

        // Use first story as the primary story for routing/context
        story = storiesToExecute[0];
        // Always derive routing from current config (modelTier not cached)
        routing = routeTask(story.title, story.description, story.acceptanceCriteria, story.tags, config);
        routing = applyCachedRouting(routing, story, config);
      } else {
        // Fallback to single-story mode (when batching disabled or batch plan exhausted)
        const nextStory = getNextStory(prd);
        if (!nextStory) {
          logger?.warn("execution", "No actionable stories (check dependencies)");
          break;
        }

        story = nextStory;
        storiesToExecute = [story];
        isBatchExecution = false;

        // Always derive routing from current config (modelTier not cached)
        routing = routeTask(story.title, story.description, story.acceptanceCriteria, story.tags, config);
        routing = applyCachedRouting(routing, story, config);
      }

      // BUG-16 + BUG-17: Pre-iteration tier escalation check
      // Check if story has exceeded current tier's attempt budget BEFORE spawning agent
      const currentTier = story.routing?.modelTier ?? routing.modelTier;
      const tierOrder = config.autoMode.escalation?.tierOrder || [];
      const tierCfg = tierOrder.length > 0 ? getTierConfig(currentTier, tierOrder) : undefined;

      if (tierCfg && (story.attempts ?? 0) >= tierCfg.attempts) {
        // Exceeded current tier budget — try to escalate
        const nextTier = escalateTier(currentTier, tierOrder);

        if (nextTier && config.autoMode.escalation.enabled) {
          logger?.warn("escalation", "Story exceeded tier budget, escalating", {
            storyId: story.id,
            attempts: story.attempts,
            tierAttempts: tierCfg.attempts,
            currentTier,
            nextTier,
          });

          // Update story routing in PRD and reset attempts for new tier
          prd.userStories = prd.userStories.map((s) =>
            s.id === story.id
              ? {
                  ...s,
                  attempts: 0, // Reset attempts for new tier
                  routing: s.routing ? { ...s.routing, modelTier: nextTier } : { ...routing, modelTier: nextTier },
                }
              : s,
          );
          await savePRD(prd, prdPath);
          prdDirty = true;

          // Hybrid mode: re-route story after escalation
          if (routingMode === "hybrid") {
            await tryLlmBatchRoute(config, [story], "hybrid-re-route");
          }

          // Skip to next iteration (will reload PRD and use new tier)
          continue;
        }
        // No next tier or escalation disabled — mark story as failed
        logger?.error("execution", "Story failed - all tiers exhausted", {
          storyId: story.id,
          attempts: story.attempts,
        });
        markStoryFailed(prd, story.id);
        await savePRD(prd, prdPath);
        prdDirty = true;

        if (featureDir) {
          await appendProgress(featureDir, story.id, "failed", `${story.title} — All tiers exhausted`);
        }

        await fireHook(
          hooks,
          "on-story-fail",
          hookCtx(feature, {
            storyId: story.id,
            status: "failed",
            reason: `All tiers exhausted (${story.attempts} attempts)`,
            cost: totalCost,
          }),
          workdir,
        );

        // Skip to next iteration (will pick next story)
        continue;
      }

      // Check cost limit
      if (totalCost >= config.execution.costLimit) {
        logger?.warn("execution", "Cost limit reached, pausing", {
          totalCost,
          costLimit: config.execution.costLimit,
        });
        await fireHook(
          hooks,
          "on-pause",
          hookCtx(feature, {
            storyId: story.id,
            reason: `Cost limit reached: $${totalCost.toFixed(2)}`,
            cost: totalCost,
          }),
          workdir,
        );
        break;
      }

      logger?.info("execution", `Starting iteration ${iterations}`, {
        iteration: iterations,
        isBatch: isBatchExecution,
        batchSize: isBatchExecution ? storiesToExecute.length : 1,
        storyId: story.id,
        storyTitle: story.title,
        ...(isBatchExecution && { batchStoryIds: storiesToExecute.map((s) => s.id) }),
      });

      // Log iteration start
      logger?.info("iteration.start", `Starting iteration ${iterations}`, {
        iteration: iterations,
        storyId: story.id,
        storyTitle: story.title,
        isBatch: isBatchExecution,
        batchSize: isBatchExecution ? storiesToExecute.length : 1,
        modelTier: routing.modelTier,
        complexity: routing.complexity,
      });

      // Fire story-start hook
      await fireHook(
        hooks,
        "on-story-start",
        hookCtx(feature, {
          storyId: story.id,
          model: routing.modelTier,
          agent: config.autoMode.defaultAgent,
          iteration: iterations,
        }),
        workdir,
      );

      if (dryRun) {
        logger?.info("execution", "[DRY RUN] Would execute agent here", {
          storyId: story.id,
        });
        continue;
      }

      // Capture git ref for scoped verification
      const storyGitRef = await captureGitRef(workdir);

      // Build pipeline context
      const storyStartTime = new Date().toISOString();
      const pipelineContext: PipelineContext = {
        config,
        prd,
        story,
        stories: storiesToExecute,
        routing: routing as RoutingResult,
        workdir,
        featureDir,
        hooks,
        plugins: pluginRegistry,
        storyStartTime,
      };

      // Log agent start
      logger?.info("agent.start", "Starting agent execution", {
        storyId: story.id,
        agent: config.autoMode.defaultAgent,
        modelTier: routing.modelTier,
        testStrategy: routing.testStrategy,
        isBatch: isBatchExecution,
      });

      // Run pipeline
      const pipelineResult = await runPipeline(defaultPipeline, pipelineContext, eventEmitter);

      // Log agent complete
      logger?.info("agent.complete", "Agent execution completed", {
        storyId: story.id,
        success: pipelineResult.success,
        finalAction: pipelineResult.finalAction,
        estimatedCost: pipelineResult.context.agentResult?.estimatedCost,
      });

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
        const verifyResult = await runPostAgentVerification({
          config,
          prd,
          prdPath,
          workdir,
          featureDir,
          story,
          storiesToExecute,
          allStoryMetrics,
          timeoutRetryCountMap,
          storyGitRef,
        });
        const verificationPassed = verifyResult.passed;
        prd = verifyResult.prd;

        if (verificationPassed) {
          storiesCompleted += storiesToExecute.length;

          // Log story completion and emit reporter events
          for (const completedStory of storiesToExecute) {
            logger?.info("story.complete", "Story completed successfully", {
              storyId: completedStory.id,
              storyTitle: completedStory.title,
              totalCost,
              durationMs: Date.now() - startTime,
            });

            // Emit onStoryComplete to reporters
            for (const reporter of reporters) {
              if (reporter.onStoryComplete) {
                try {
                  await reporter.onStoryComplete({
                    runId,
                    storyId: completedStory.id,
                    status: "completed",
                    durationMs: Date.now() - startTime,
                    cost: pipelineResult.context.agentResult?.estimatedCost || 0,
                    tier: routing.modelTier,
                    testStrategy: routing.testStrategy,
                  });
                } catch (error) {
                  logger?.warn("plugins", `Reporter '${reporter.name}' onStoryComplete failed`, { error });
                }
              }
            }
          }
        }

        // Display progress
        const updatedCounts = countStories(prd);
        const elapsedMs = Date.now() - startTime;
        logger?.info("progress", "Progress update", {
          totalStories: updatedCounts.total,
          passedStories: updatedCounts.passed,
          failedStories: updatedCounts.failed,
          pendingStories: updatedCounts.pending,
          totalCost,
          costLimit: config.execution.costLimit,
          elapsedMs,
        });
      } else {
        // Pipeline stopped early — handle based on finalAction
        switch (pipelineResult.finalAction) {
          case "pause":
            // Mark story as paused and continue with non-dependent stories
            markStoryPaused(prd, story.id);
            await savePRD(prd, prdPath);
            prdDirty = true;

            logger?.warn("pipeline", "Story paused", {
              storyId: story.id,
              reason: pipelineResult.reason,
            });

            await fireHook(
              hooks,
              "on-pause",
              hookCtx(feature, {
                storyId: story.id,
                reason: pipelineResult.reason || "Pipeline paused",
                cost: totalCost,
              }),
              workdir,
            );

            // Emit onStoryComplete to reporters
            for (const reporter of reporters) {
              if (reporter.onStoryComplete) {
                try {
                  await reporter.onStoryComplete({
                    runId,
                    storyId: story.id,
                    status: "paused",
                    durationMs: Date.now() - startTime,
                    cost: pipelineResult.context.agentResult?.estimatedCost || 0,
                    tier: routing.modelTier,
                    testStrategy: routing.testStrategy,
                  });
                } catch (error) {
                  logger?.warn("plugins", `Reporter '${reporter.name}' onStoryComplete failed`, { error });
                }
              }
            }

            // Continue to next story instead of returning
            break;

          case "skip":
            // Story already marked as skipped in queue-check stage
            logger?.warn("pipeline", "Story skipped", {
              storyId: story.id,
              reason: pipelineResult.reason,
            });
            prdDirty = true;

            // Emit onStoryComplete to reporters
            for (const reporter of reporters) {
              if (reporter.onStoryComplete) {
                try {
                  await reporter.onStoryComplete({
                    runId,
                    storyId: story.id,
                    status: "skipped",
                    durationMs: Date.now() - startTime,
                    cost: 0,
                    tier: routing.modelTier,
                    testStrategy: routing.testStrategy,
                  });
                } catch (error) {
                  logger?.warn("plugins", `Reporter '${reporter.name}' onStoryComplete failed`, { error });
                }
              }
            }
            break;

          case "fail":
            // Mark first story as failed and stop
            markStoryFailed(prd, story.id);
            await savePRD(prd, prdPath);
            prdDirty = true;

            logger?.error("pipeline", "Story failed", {
              storyId: story.id,
              reason: pipelineResult.reason,
            });

            if (featureDir) {
              await appendProgress(featureDir, story.id, "failed", `${story.title} — ${pipelineResult.reason}`);
            }

            await fireHook(
              hooks,
              "on-story-fail",
              hookCtx(feature, {
                storyId: story.id,
                status: "failed",
                reason: pipelineResult.reason || "Pipeline failed",
                cost: totalCost,
              }),
              workdir,
            );

            // Emit onStoryComplete to reporters
            for (const reporter of reporters) {
              if (reporter.onStoryComplete) {
                try {
                  await reporter.onStoryComplete({
                    runId,
                    storyId: story.id,
                    status: "failed",
                    durationMs: Date.now() - startTime,
                    cost: pipelineResult.context.agentResult?.estimatedCost || 0,
                    tier: routing.modelTier,
                    testStrategy: routing.testStrategy,
                  });
                } catch (error) {
                  logger?.warn("plugins", `Reporter '${reporter.name}' onStoryComplete failed`, { error });
                }
              }
            }

            break;

          case "escalate": {
            // Escalate to next tier
            const nextTier = escalateTier(routing.modelTier, config.autoMode.escalation.tierOrder);
            const escalateWholeBatch = config.autoMode.escalation.escalateEntireBatch ?? true;
            const storiesToEscalate = isBatchExecution && escalateWholeBatch ? storiesToExecute : [story];

            if (nextTier && config.autoMode.escalation.enabled) {
              const maxAttempts = calculateMaxIterations(config.autoMode.escalation.tierOrder);
              const canEscalate = storiesToEscalate.every((s) => (s.attempts ?? 0) < maxAttempts);

              if (canEscalate) {
                for (const s of storiesToEscalate) {
                  logger?.warn("escalation", "Escalating story to next tier", {
                    storyId: s.id,
                    nextTier,
                  });
                }

                const errorMessage = `Attempt ${story.attempts + 1} failed with model tier: ${routing.modelTier}${isBatchExecution ? " (in batch)" : ""}`;

                prd.userStories = prd.userStories.map((s) => {
                  const shouldEscalate = storiesToEscalate.some((story) => story.id === s.id);
                  return shouldEscalate
                    ? {
                        ...s,
                        attempts: (s.attempts ?? 0) + 1,
                        routing: s.routing ? { ...s.routing, modelTier: nextTier } : undefined,
                        priorErrors: [...(s.priorErrors || []), errorMessage],
                      }
                    : s;
                });
                await savePRD(prd, prdPath);
                prdDirty = true;

                // Hybrid mode: re-route escalated stories
                if (routingMode === "hybrid") {
                  await tryLlmBatchRoute(config, storiesToEscalate, "hybrid-re-route-pipeline");
                }
              } else {
                // Max attempts reached — mark as failed
                markStoryFailed(prd, story.id);
                await savePRD(prd, prdPath);
                prdDirty = true;

                logger?.error("execution", "Story failed - max attempts reached", {
                  storyId: story.id,
                });

                if (featureDir) {
                  await appendProgress(featureDir, story.id, "failed", `${story.title} — Max attempts reached`);
                }

                await fireHook(
                  hooks,
                  "on-story-fail",
                  hookCtx(feature, {
                    storyId: story.id,
                    status: "failed",
                    reason: "Max attempts reached",
                    cost: totalCost,
                  }),
                  workdir,
                );

                break;
              }
            } else {
              // No next tier or escalation disabled — mark as failed
              markStoryFailed(prd, story.id);
              await savePRD(prd, prdPath);
              prdDirty = true;

              logger?.error("execution", "Story failed - execution failed", {
                storyId: story.id,
              });

              if (featureDir) {
                await appendProgress(featureDir, story.id, "failed", `${story.title} — Execution failed`);
              }

              await fireHook(
                hooks,
                "on-story-fail",
                hookCtx(feature, {
                  storyId: story.id,
                  status: "failed",
                  reason: "Execution failed",
                  cost: totalCost,
                }),
                workdir,
              );

              break;
            }
            break;
          }
        }
      }

      // ADR-003: Stall detection — all remaining stories blocked or dependent on blocked
      if (prdDirty) {
        prd = await loadPRD(prdPath);
        prdDirty = false;
      }
      if (isStalled(prd)) {
        const summary = generateHumanHaltSummary(prd);
        logger?.error("execution", "Execution stalled", {
          reason: "All remaining stories blocked or dependent on blocked stories",
          summary,
        });
        await fireHook(
          hooks,
          "on-pause",
          hookCtx(feature, {
            reason: "All remaining stories blocked or dependent on blocked stories",
            cost: totalCost,
          }),
          workdir,
        );
        break;
      }

      // Delay between iterations
      if (config.execution.iterationDelayMs > 0) {
        await Bun.sleep(config.execution.iterationDelayMs);
      }
    }

    // After main loop: Check if we need acceptance retry loop
    if (config.acceptance.enabled && isComplete(prd)) {
      logger?.info("acceptance", "All stories complete, running acceptance validation");

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
          plugins: pluginRegistry,
        };

        // Run acceptance stage
        const { acceptanceStage } = await import("../pipeline/stages/acceptance");
        const acceptanceResult = await acceptanceStage.execute(acceptanceContext);

        if (acceptanceResult.action === "continue") {
          // All acceptance tests passed
          logger?.info("acceptance", "Acceptance validation passed!");
          break;
        }

        // Acceptance tests failed
        if (acceptanceResult.action === "fail") {
          const failures = acceptanceContext.acceptanceFailures;

          if (!failures || failures.failedACs.length === 0) {
            logger?.error("acceptance", "Acceptance tests failed but no specific failures detected");
            logger?.warn("acceptance", "Manual intervention required");
            await fireHook(
              hooks,
              "on-pause",
              hookCtx(feature, {
                reason: "Acceptance tests failed (no failures detected)",
                cost: totalCost,
              }),
              workdir,
            );
            break;
          }

          acceptanceRetries++;
          logger?.warn("acceptance", `Acceptance retry ${acceptanceRetries}/${maxRetries}`, {
            failedACs: failures.failedACs,
          });

          if (acceptanceRetries >= maxRetries) {
            logger?.error("acceptance", "Max acceptance retries reached");
            logger?.warn("acceptance", "Manual intervention required");
            logger?.debug("acceptance", 'Run: nax accept --override AC-N "reason" to skip specific ACs');
            await fireHook(
              hooks,
              "on-pause",
              hookCtx(feature, {
                reason: `Acceptance validation failed after ${maxRetries} retries: ${failures.failedACs.join(", ")}`,
                cost: totalCost,
              }),
              workdir,
            );
            break;
          }

          // Generate fix stories
          logger?.info("acceptance", "Generating fix stories...");

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
            logger?.error("acceptance", "Agent not found, cannot generate fix stories");
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
            logger?.error("acceptance", "Failed to generate fix stories");
            break;
          }

          logger?.info("acceptance", `Generated ${fixStories.length} fix stories`);

          // Append fix stories to PRD
          for (const fixStory of fixStories) {
            const userStory = convertFixStoryToUserStory(fixStory);
            prd.userStories.push(userStory);
            logger?.debug("acceptance", `Fix story added: ${userStory.id}: ${userStory.title}`);
          }

          await savePRD(prd, prdPath);
          prdDirty = true;

          // Re-run pipeline for fix stories only
          logger?.info("acceptance", "Running fix stories...");

          for (const fixStory of fixStories) {
            const userStory = prd.userStories.find((s) => s.id === fixStory.id);
            if (!userStory || userStory.status !== "pending") continue;

            iterations++;

            const routing = routeTask(
              userStory.title,
              userStory.description,
              userStory.acceptanceCriteria,
              userStory.tags,
              config,
            );

            logger?.info("acceptance", `Starting fix story: ${userStory.id}`, {
              storyId: userStory.id,
              storyTitle: userStory.title,
            });

            await fireHook(
              hooks,
              "on-story-start",
              hookCtx(feature, {
                storyId: userStory.id,
                model: routing.modelTier,
                agent: config.autoMode.defaultAgent,
                iteration: iterations,
              }),
              workdir,
            );

            const fixStoryStartTime = new Date().toISOString();
            const fixContext: PipelineContext = {
              config,
              prd,
              story: userStory,
              stories: [userStory],
              routing: routing as RoutingResult,
              workdir,
              featureDir,
              hooks,
              plugins: pluginRegistry,
              storyStartTime: fixStoryStartTime,
            };

            const fixResult = await runPipeline(defaultPipeline, fixContext, eventEmitter);
            prd = fixResult.context.prd;

            if (fixResult.success) {
              storiesCompleted++;
              totalCost += fixResult.context.agentResult?.estimatedCost || 0;
              logger?.info("acceptance", `Fix story ${userStory.id} passed`);

              // Collect fix story metrics
              if (fixResult.context.storyMetrics) {
                allStoryMetrics.push(...fixResult.context.storyMetrics);
              }
            } else {
              logger?.error("acceptance", `Fix story ${userStory.id} failed`);
            }

            await savePRD(prd, prdPath);
            prdDirty = true;
          }

          logger?.info("acceptance", "Re-running acceptance tests...");
          // Loop will re-run acceptance tests
        } else {
          // Unexpected result from acceptance stage
          logger?.warn("acceptance", `Unexpected acceptance result: ${acceptanceResult.action}`);
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

    // Log run completion
    const finalCounts = countStories(prd);

    // Prepare per-story metrics summary
    const storyMetricsSummary = allStoryMetrics.map((sm) => ({
      storyId: sm.storyId,
      complexity: sm.complexity,
      modelTier: sm.modelTier,
      modelUsed: sm.modelUsed,
      attempts: sm.attempts,
      finalTier: sm.finalTier,
      success: sm.success,
      cost: sm.cost,
      durationMs: sm.durationMs,
      firstPassSuccess: sm.firstPassSuccess,
    }));

    logger?.info("run.complete", "Feature execution completed", {
      runId,
      feature,
      success: isComplete(prd),
      iterations,
      totalStories: finalCounts.total,
      storiesCompleted,
      storiesFailed: finalCounts.failed,
      storiesPending: finalCounts.pending,
      totalCost,
      durationMs,
      storyMetrics: storyMetricsSummary,
    });

    // Emit onRunEnd to reporters
    for (const reporter of reporters) {
      if (reporter.onRunEnd) {
        try {
          await reporter.onRunEnd({
            runId,
            totalDurationMs: durationMs,
            totalCost,
            storySummary: {
              completed: storiesCompleted,
              failed: finalCounts.failed,
              skipped: finalCounts.skipped,
              paused: finalCounts.paused,
            },
          });
        } catch (error) {
          logger?.warn("plugins", `Reporter '${reporter.name}' onRunEnd failed`, { error });
        }
      }
    }

    return {
      success: isComplete(prd),
      iterations,
      storiesCompleted,
      totalCost,
      durationMs,
    };
  } finally {
    // Teardown plugins
    try {
      await pluginRegistry.teardownAll();
    } catch (error) {
      logger?.warn("plugins", "Plugin teardown failed", { error });
    }

    // Always release lock, even if execution fails
    await releaseLock(workdir);
  }
}

// Re-exports for backward compatibility with existing test imports
export { buildSingleSessionPrompt, buildBatchPrompt } from "./prompts";
export { groupStoriesIntoBatches, type StoryBatch } from "./batching";
export { escalateTier } from "./escalation";
