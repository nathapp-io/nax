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
import path from "node:path";
import type { NgentConfig, ModelTier } from "../config";
import { resolveModel } from "../config";
import type { AgentAdapter } from "../agents";
import { getAgent, getInstalledAgents } from "../agents";
import { loadPRD, savePRD, getNextStory, isComplete, countStories, markStoryPassed, markStoryFailed, markStorySkipped } from "../prd";
import type { PRD, UserStory } from "../prd";
import { routeTask, type RoutingDecision } from "../routing";
import { fireHook, type HooksConfig } from "../hooks";
import type { HookContext } from "../hooks";
import { runThreeSessionTdd } from "../tdd";
import { appendProgress } from "./progress";
import { buildContext, formatContextAsMarkdown } from "../context";
import type { StoryContext, ContextBudget } from "../context";
import { parseQueueFile } from "../queue";
import type { QueueCommand } from "../queue";

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

/** Build prompt for single-session (test-after) execution */
function buildSingleSessionPrompt(story: UserStory, contextMarkdown?: string): string {
  const basePrompt = `# Task: ${story.title}

**Description:**
${story.description}

**Acceptance Criteria:**
${story.acceptanceCriteria.map((ac, i) => `${i + 1}. ${ac}`).join("\n")}

**Instructions:**
1. Implement the functionality described above
2. Write tests to verify all acceptance criteria are met
3. Ensure all tests pass
4. Follow existing code patterns and conventions
5. Commit your changes when done

Use test-after approach: implement first, then add tests to verify.`;

  if (contextMarkdown) {
    return `${basePrompt}

---

${contextMarkdown}`;
  }

  return basePrompt;
}

/** Build prompt for batched stories (multiple simple stories in one session) */
export function buildBatchPrompt(stories: UserStory[], contextMarkdown?: string): string {
  const storyPrompts = stories
    .map((story, idx) => {
      return `## Story ${idx + 1}: ${story.id} — ${story.title}

**Description:**
${story.description}

**Acceptance Criteria:**
${story.acceptanceCriteria.map((ac, i) => `${i + 1}. ${ac}`).join("\n")}`;
    })
    .join("\n\n");

  const basePrompt = `# Batch Task: ${stories.length} Stories

You are assigned ${stories.length} related stories to implement in sequence. Each story should be implemented, tested, and committed separately.

${storyPrompts}

**Instructions:**
1. Implement each story in order
2. Write tests to verify all acceptance criteria are met for each story
3. Ensure all tests pass for each story
4. **Commit each story separately** with a clear commit message referencing the story ID
5. Follow existing code patterns and conventions

Use test-after approach: implement first, then add tests to verify.`;

  if (contextMarkdown) {
    return `${basePrompt}

---

${contextMarkdown}`;
  }

  return basePrompt;
}

/** Story batch for grouped execution */
export interface StoryBatch {
  stories: UserStory[];
  isBatch: boolean;
}

/**
 * Group consecutive simple-complexity stories into batches (max 4 per batch).
 * Non-simple stories execute individually.
 */
export function groupStoriesIntoBatches(
  stories: UserStory[],
  maxBatchSize = 4,
): StoryBatch[] {
  const batches: StoryBatch[] = [];
  let currentBatch: UserStory[] = [];

  for (const story of stories) {
    const isSimple = story.routing?.complexity === "simple";

    if (isSimple && currentBatch.length < maxBatchSize) {
      // Add to current batch
      currentBatch.push(story);
    } else {
      // Flush current batch if it exists
      if (currentBatch.length > 0) {
        batches.push({
          stories: [...currentBatch],
          isBatch: currentBatch.length > 1,
        });
        currentBatch = [];
      }

      // Add non-simple story as individual batch
      if (!isSimple) {
        batches.push({
          stories: [story],
          isBatch: false,
        });
      } else {
        // Start new batch with this simple story
        currentBatch.push(story);
      }
    }
  }

  // Flush remaining batch
  if (currentBatch.length > 0) {
    batches.push({
      stories: [...currentBatch],
      isBatch: currentBatch.length > 1,
    });
  }

  return batches;
}

/** Build story context for context builder */
async function buildStoryContext(
  prd: PRD,
  story: UserStory,
  config: NgentConfig,
): Promise<string | undefined> {
  try {
    const storyContext: StoryContext = {
      prd,
      currentStoryId: story.id,
    };

    const budget: ContextBudget = {
      maxTokens: 100000, // Conservative limit for Claude
      reservedForInstructions: 10000,
      availableForContext: 90000,
    };

    const built = await buildContext(storyContext, budget);

    if (built.elements.length === 0) {
      return undefined;
    }

    return formatContextAsMarkdown(built);
  } catch (error) {
    console.warn(chalk.yellow(`   ⚠️  Context builder failed: ${(error as Error).message}`));
    return undefined;
  }
}

/** Escalate model tier through explicit 3-tier chain: fast → balanced → powerful → null */
export function escalateTier(current: ModelTier): ModelTier | null {
  // Explicit escalation chain
  switch (current) {
    case "fast":
      return "balanced";
    case "balanced":
      return "powerful";
    case "powerful":
      return null; // Max tier reached
    default:
      return null;
  }
}

/** Build a hook context */
function hookCtx(
  feature: string,
  opts?: Partial<Omit<HookContext, "event" | "feature">>,
): HookContext {
  return {
    event: "on-start", // overridden by fireHook
    feature,
    ...opts,
  };
}

/** Maybe build context if enabled */
async function maybeGetContext(
  prd: PRD,
  story: UserStory,
  config: NgentConfig,
  useContext: boolean,
): Promise<string | undefined> {
  if (!useContext) {
    return undefined;
  }

  console.log(chalk.dim(`   ⚙️  Building context...`));
  const contextMarkdown = await buildStoryContext(prd, story, config);
  if (contextMarkdown) {
    console.log(chalk.dim(`   ✓ Context built`));
  }
  return contextMarkdown;
}

/** Read and parse queue file */
async function readQueueFile(workdir: string): Promise<QueueCommand[]> {
  const queuePath = path.join(workdir, ".queue.txt");
  try {
    const file = Bun.file(queuePath);
    const exists = await file.exists();
    if (!exists) {
      return [];
    }
    const content = await file.text();
    const result = parseQueueFile(content);
    return result.commands;
  } catch (error) {
    console.warn(chalk.yellow(`   ⚠️  Failed to read queue file: ${(error as Error).message}`));
    return [];
  }
}

/** Clear queue file after processing commands */
async function clearQueueFile(workdir: string): Promise<void> {
  const queuePath = path.join(workdir, ".queue.txt");
  try {
    await Bun.write(queuePath, "");
  } catch (error) {
    console.warn(chalk.yellow(`   ⚠️  Failed to clear queue file: ${(error as Error).message}`));
  }
}

/** Result from executing a batch or single story */
interface ExecutionResult {
  success: boolean;
  cost: number;
  storiesProcessed: string[];
}

/** Get all stories that are ready to execute (pending, dependencies satisfied) */
function getAllReadyStories(prd: PRD): UserStory[] {
  const completedIds = new Set(
    prd.userStories
      .filter((s) => s.passes || s.status === "skipped")
      .map((s) => s.id),
  );

  return prd.userStories.filter(
    (s) =>
      !s.passes &&
      s.status !== "skipped" &&
      s.dependencies.every((dep) => completedIds.has(dep)),
  );
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

  // Fire on-start hook
  await fireHook(hooks, "on-start", hookCtx(feature), workdir);

  // Load PRD
  let prd = await loadPRD(prdPath);
  const counts = countStories(prd);
  console.log(chalk.cyan(`\n🚀 ngent: Starting ${feature}`));
  console.log(chalk.dim(`   Stories: ${counts.total} (${counts.passed} done, ${counts.pending} pending)`));
  if (useBatch) {
    console.log(chalk.dim(`   Batching: enabled (groups consecutive simple stories, max 4/batch)`));
  }

  // Main loop
  while (iterations < config.execution.maxIterations) {
    iterations++;

    // Reload PRD each iteration (agent may have updated it)
    prd = await loadPRD(prdPath);

    // Check completion
    if (isComplete(prd)) {
      console.log(chalk.green.bold("\n✅ All stories complete!"));
      await fireHook(hooks, "on-complete", hookCtx(feature, { status: "complete", cost: totalCost }), workdir);
      break;
    }

    // Find next story
    const story = getNextStory(prd);
    if (!story) {
      console.log(chalk.yellow("\n⚠️  No actionable stories (check dependencies)"));
      break;
    }

    // Route the task
    const routing = routeTask(
      story.title,
      story.description,
      story.acceptanceCriteria,
      story.tags,
      config,
    );

    // Check if we should batch this story with others
    let storiesToExecute: UserStory[] = [story];
    let isBatchExecution = false;

    if (
      useBatch &&
      routing.complexity === "simple" &&
      routing.testStrategy === "test-after"
    ) {
      // Get all ready stories and try to form a batch
      const readyStories = getAllReadyStories(prd);
      const currentIndex = readyStories.findIndex((s) => s.id === story.id);

      if (currentIndex !== -1) {
        // Collect consecutive simple stories (max 4 total)
        const batchCandidates = [story];
        for (let i = currentIndex + 1; i < readyStories.length && batchCandidates.length < 4; i++) {
          const candidate = readyStories[i];
          const candidateRouting = routeTask(
            candidate.title,
            candidate.description,
            candidate.acceptanceCriteria,
            candidate.tags,
            config,
          );

          if (
            candidateRouting.complexity === "simple" &&
            candidateRouting.testStrategy === "test-after"
          ) {
            batchCandidates.push(candidate);
          } else {
            // Stop at first non-simple story
            break;
          }
        }

        if (batchCandidates.length > 1) {
          storiesToExecute = batchCandidates;
          isBatchExecution = true;
        }
      }
    }

    // Check queue file for commands BEFORE executing batch
    const queueCommands = await readQueueFile(workdir);
    let skippedAnyStory = false;

    for (const cmd of queueCommands) {
      if (cmd === "PAUSE") {
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
      } else if (cmd === "ABORT") {
        console.log(chalk.yellow("\n🛑 Aborting: marking remaining stories as skipped"));

        // Mark all pending stories as skipped
        prd.userStories.forEach((s) => {
          if (s.status === "pending") {
            markStorySkipped(prd, s.id);
          }
        });
        await savePRD(prd, prdPath);
        await clearQueueFile(workdir);

        return {
          success: false,
          iterations,
          storiesCompleted,
          totalCost,
          durationMs: Date.now() - startTime,
        };
      } else if (typeof cmd === "object" && cmd.type === "SKIP") {
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

    // Get agent
    const agent = getAgent(config.autoMode.defaultAgent);
    if (!agent) {
      console.error(chalk.red(`Agent "${config.autoMode.defaultAgent}" not found`));
      break;
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

      // Check queue file for commands after story completion
      const queueCommands = await readQueueFile(workdir);

      for (const cmd of queueCommands) {
        if (cmd === "PAUSE") {
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
        } else if (cmd === "ABORT") {
          console.log(chalk.yellow("\n🛑 Aborting: marking remaining stories as skipped"));

          // Mark all pending stories as skipped
          prd.userStories.forEach((s) => {
            if (s.status === "pending") {
              markStorySkipped(prd, s.id);
            }
          });
          await savePRD(prd, prdPath);
          await clearQueueFile(workdir);

          return {
            success: false,
            iterations,
            storiesCompleted,
            totalCost,
            durationMs: Date.now() - startTime,
          };
        } else if (typeof cmd === "object" && cmd.type === "SKIP") {
          console.log(chalk.yellow(`   ⏭️  Skipping story ${cmd.storyId} by user request`));
          markStorySkipped(prd, cmd.storyId);
          await savePRD(prd, prdPath);
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
      const nextTier = escalateTier(routing.modelTier);

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
      } else {
        markStoryFailed(prd, failedStory.id);
        await savePRD(prd, prdPath);

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
}
