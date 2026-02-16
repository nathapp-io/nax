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
import type { AgentAdapter, ModelTier } from "../agents";
import { getAgent, getInstalledAgents } from "../agents";
import { loadPRD, savePRD, getNextStory, isComplete, countStories, markStoryPassed, markStoryFailed } from "../prd";
import type { PRD, UserStory } from "../prd";
import { routeTask, type RoutingDecision } from "../routing";
import { fireHook, type HooksConfig } from "../hooks";
import type { HookContext } from "../hooks";
import { runThreeSessionTdd } from "../tdd";

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
  /** Dry run */
  dryRun: boolean;
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
function buildSingleSessionPrompt(story: UserStory): string {
  return `# Task: ${story.title}

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
}

/** Escalate model tier */
function escalateTier(current: ModelTier): ModelTier | null {
  const path: ModelTier[] = ["cheap", "standard", "premium"];
  const idx = path.indexOf(current);
  if (idx < 0 || idx >= path.length - 1) return null;
  return path[idx + 1];
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

/**
 * Main execution loop
 */
export async function run(options: RunOptions): Promise<RunResult> {
  const { prdPath, workdir, config, hooks, feature, dryRun } = options;
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
    console.log(chalk.white(`   Story: ${story.id} — ${story.title}`));
    console.log(chalk.dim(`   Complexity: ${routing.complexity} | Model: ${routing.modelTier} | TDD: ${routing.testStrategy}`));
    console.log(chalk.dim(`   Routing: ${routing.reasoning}`));

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
      const tddResult = await runThreeSessionTdd(
        agent,
        story,
        config,
        workdir,
        routing.modelTier,
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
      // test-after: single agent session
      const prompt = buildSingleSessionPrompt(story);
      console.log(chalk.cyan(`\n   → Single session (test-after)`));

      const result = await agent.run({
        prompt,
        workdir,
        modelTier: routing.modelTier,
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
      markStoryPassed(prd, story.id);
      await savePRD(prd, prdPath);
      storiesCompleted++;

      console.log(chalk.green(`   ✓ Story ${story.id} passed`));

      // Fire story-complete hook
      await fireHook(hooks, "on-story-complete", hookCtx(feature, {
        storyId: story.id,
        status: "passed",
        cost: sessionCost,
      }), workdir);
    } else {
      // Handle failure — either escalate or mark failed
      const nextTier = escalateTier(routing.modelTier);
      if (nextTier && config.autoMode.escalation.enabled && story.attempts < config.autoMode.escalation.maxAttempts) {
        console.log(chalk.yellow(`   ⬆️  Escalating to ${nextTier}`));
        // Update PRD with escalation (not marking as failed yet)
        prd.userStories = prd.userStories.map((s) =>
          s.id === story.id
            ? {
                ...s,
                attempts: s.attempts + 1,
                routing: s.routing
                  ? { ...s.routing, modelTier: nextTier }
                  : undefined,
              }
            : s,
        );
        await savePRD(prd, prdPath);
      } else {
        markStoryFailed(prd, story.id);
        await savePRD(prd, prdPath);

        console.log(chalk.red(`   ✗ Story ${story.id} failed`));

        await fireHook(hooks, "on-story-fail", hookCtx(feature, {
          storyId: story.id,
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
