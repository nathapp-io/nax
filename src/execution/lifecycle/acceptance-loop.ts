/**
 * Acceptance Retry Loop
 *
 * Handles the acceptance testing retry loop after main execution completes:
 * 1. Runs acceptance validation
 * 2. Generates fix stories for failed acceptance criteria
 * 3. Executes fix stories through pipeline
 * 4. Retries until max retries or all tests pass
 */

import path from "node:path";
import { type FixStory, convertFixStoryToUserStory, generateFixStories } from "../../acceptance";
import type { NaxConfig } from "../../config";
import { resolveModel } from "../../config/schema";
import { type LoadedHooksConfig, fireHook } from "../../hooks";
import { getSafeLogger } from "../../logger";
import type { StoryMetrics } from "../../metrics";
import type { PipelineEventEmitter } from "../../pipeline/events";
import { runPipeline } from "../../pipeline/runner";
import { defaultPipeline } from "../../pipeline/stages";
import type { AgentGetFn } from "../../pipeline/types";
import type { PipelineContext, RoutingResult } from "../../pipeline/types";
import type { PluginRegistry } from "../../plugins";
import { loadPRD, savePRD } from "../../prd";
import type { PRD, UserStory } from "../../prd/types";
import { routeTask } from "../../routing";
import { hookCtx } from "../helpers";
import type { StatusWriter } from "../status-writer";

export interface AcceptanceLoopContext {
  config: NaxConfig;
  prd: PRD;
  prdPath: string;
  workdir: string;
  featureDir?: string;
  hooks: LoadedHooksConfig;
  feature: string;
  totalCost: number;
  iterations: number;
  storiesCompleted: number;
  allStoryMetrics: StoryMetrics[];
  pluginRegistry: PluginRegistry;
  eventEmitter?: PipelineEventEmitter;
  statusWriter: StatusWriter;
  /** Protocol-aware agent resolver — passed from registry at run start */
  agentGetFn?: AgentGetFn;
}

export interface AcceptanceLoopResult {
  success: boolean;
  prd: PRD;
  totalCost: number;
  iterations: number;
  storiesCompleted: number;
  prdDirty: boolean;
}

/** Load spec.md content for AC text */
async function loadSpecContent(featureDir?: string): Promise<string> {
  if (!featureDir) return "";
  const specPath = path.join(featureDir, "spec.md");
  const specFile = Bun.file(specPath);
  return (await specFile.exists()) ? await specFile.text() : "";
}

/** Build result object for loop exit */
function buildResult(
  success: boolean,
  prd: PRD,
  totalCost: number,
  iterations: number,
  storiesCompleted: number,
  prdDirty: boolean,
): AcceptanceLoopResult {
  return { success, prd, totalCost, iterations, storiesCompleted, prdDirty };
}

/** Generate and add fix stories to PRD */
async function generateAndAddFixStories(
  ctx: AcceptanceLoopContext,
  failures: { failedACs: string[]; testOutput: string },
  prd: PRD,
): Promise<FixStory[] | null> {
  const logger = getSafeLogger();
  const { getAgent } = await import("../../agents");
  const agent = (ctx.agentGetFn ?? getAgent)(ctx.config.autoMode.defaultAgent);
  if (!agent) {
    logger?.error("acceptance", "Agent not found, cannot generate fix stories");
    return null;
  }
  const modelDef = resolveModel(ctx.config.models[ctx.config.analyze.model]);
  const fixStories = await generateFixStories(agent, {
    failedACs: failures.failedACs,
    testOutput: failures.testOutput,
    prd,
    specContent: await loadSpecContent(ctx.featureDir),
    workdir: ctx.workdir,
    modelDef,
    config: ctx.config,
  });
  if (fixStories.length === 0) {
    logger?.error("acceptance", "Failed to generate fix stories");
    return null;
  }
  logger?.info("acceptance", `Generated ${fixStories.length} fix stories`);
  for (const fixStory of fixStories) {
    const userStory = convertFixStoryToUserStory(fixStory);
    prd.userStories.push(userStory);
    logger?.debug("acceptance", `Fix story added: ${userStory.id}: ${userStory.title}`);
  }
  return fixStories;
}

/** Execute a single fix story through the pipeline */
async function executeFixStory(
  ctx: AcceptanceLoopContext,
  story: UserStory,
  prd: PRD,
  iterations: number,
): Promise<{ success: boolean; cost: number; metrics?: StoryMetrics[] }> {
  const logger = getSafeLogger();
  const routing = routeTask(story.title, story.description, story.acceptanceCriteria, story.tags, ctx.config);
  logger?.info("acceptance", `Starting fix story: ${story.id}`, { storyId: story.id, storyTitle: story.title });
  await fireHook(
    ctx.hooks,
    "on-story-start",
    hookCtx(ctx.feature, {
      storyId: story.id,
      model: routing.modelTier,
      agent: ctx.config.autoMode.defaultAgent,
      iteration: iterations,
    }),
    ctx.workdir,
  );
  const fixContext: PipelineContext = {
    config: ctx.config,
    prd,
    story,
    stories: [story],
    routing: routing as RoutingResult,
    workdir: ctx.workdir,
    featureDir: ctx.featureDir,
    hooks: ctx.hooks,
    plugins: ctx.pluginRegistry,
    storyStartTime: new Date().toISOString(),
  };
  const result = await runPipeline(defaultPipeline, fixContext, ctx.eventEmitter);
  logger?.info("acceptance", `Fix story ${story.id} ${result.success ? "passed" : "failed"}`);
  return {
    success: result.success,
    cost: result.context.agentResult?.estimatedCost || 0,
    metrics: result.context.storyMetrics,
  };
}

/**
 * Run the acceptance retry loop
 *
 * Executes acceptance tests and handles retry logic with fix story generation.
 */
export async function runAcceptanceLoop(ctx: AcceptanceLoopContext): Promise<AcceptanceLoopResult> {
  const logger = getSafeLogger();
  const maxRetries = ctx.config.acceptance.maxRetries;

  let acceptanceRetries = 0;
  let prd = ctx.prd;
  let totalCost = ctx.totalCost;
  let iterations = ctx.iterations;
  let storiesCompleted = ctx.storiesCompleted;
  let prdDirty = false;

  logger?.info("acceptance", "All stories complete, running acceptance validation");

  while (acceptanceRetries < maxRetries) {
    // Run acceptance validation
    const firstStory = prd.userStories[0];
    const acceptanceContext: PipelineContext = {
      config: ctx.config,
      prd,
      story: firstStory,
      stories: [firstStory],
      routing: {
        complexity: "simple",
        modelTier: "balanced",
        testStrategy: "test-after",
        reasoning: "Acceptance validation",
      },
      workdir: ctx.workdir,
      featureDir: ctx.featureDir,
      hooks: ctx.hooks,
      plugins: ctx.pluginRegistry,
    };

    const { acceptanceStage } = await import("../../pipeline/stages/acceptance");
    const acceptanceResult = await acceptanceStage.execute(acceptanceContext);

    if (acceptanceResult.action === "continue") {
      logger?.info("acceptance", "Acceptance validation passed!");
      return buildResult(true, prd, totalCost, iterations, storiesCompleted, prdDirty);
    }

    if (acceptanceResult.action !== "fail") {
      logger?.warn("acceptance", `Unexpected acceptance result: ${acceptanceResult.action}`);
      return buildResult(false, prd, totalCost, iterations, storiesCompleted, prdDirty);
    }

    // Handle acceptance test failures
    const failures = acceptanceContext.acceptanceFailures;
    if (!failures || failures.failedACs.length === 0) {
      logger?.error("acceptance", "Acceptance tests failed but no specific failures detected");
      logger?.warn("acceptance", "Manual intervention required");
      await fireHook(
        ctx.hooks,
        "on-pause",
        hookCtx(ctx.feature, { reason: "Acceptance tests failed (no failures detected)", cost: totalCost }),
        ctx.workdir,
      );
      return buildResult(false, prd, totalCost, iterations, storiesCompleted, prdDirty);
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
        ctx.hooks,
        "on-pause",
        hookCtx(ctx.feature, {
          reason: `Acceptance validation failed after ${maxRetries} retries: ${failures.failedACs.join(", ")}`,
          cost: totalCost,
        }),
        ctx.workdir,
      );
      return buildResult(false, prd, totalCost, iterations, storiesCompleted, prdDirty);
    }

    // Generate and add fix stories
    logger?.info("acceptance", "Generating fix stories...");
    const fixStories = await generateAndAddFixStories(ctx, failures, prd);
    if (!fixStories) {
      return buildResult(false, prd, totalCost, iterations, storiesCompleted, prdDirty);
    }

    await savePRD(prd, ctx.prdPath);
    prdDirty = true;

    // Execute fix stories
    logger?.info("acceptance", "Running fix stories...");
    for (const fixStory of fixStories) {
      const userStory = prd.userStories.find((s) => s.id === fixStory.id);
      if (!userStory || userStory.status !== "pending") continue;

      iterations++;
      const result = await executeFixStory(ctx, userStory, prd, iterations);
      prd = await loadPRD(ctx.prdPath); // Reload to get updated PRD

      if (result.success) {
        storiesCompleted++;
        totalCost += result.cost;
        if (result.metrics) ctx.allStoryMetrics.push(...result.metrics);
      }

      await savePRD(prd, ctx.prdPath);
      prdDirty = true;
    }

    logger?.info("acceptance", "Re-running acceptance tests...");
  }

  return buildResult(false, prd, totalCost, iterations, storiesCompleted, prdDirty);
}
