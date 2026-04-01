/**
 * Acceptance Retry Loop
 *
 * Handles the acceptance testing retry loop after main execution completes:
 * 1. Runs acceptance validation
 * 2. Detects test-level failures (>80% fail or crash) and regenerates test (P1-D)
 * 3. Generates batched fix stories for implementation-level failures
 * 4. Executes fix stories through pipeline
 * 5. Retries until max retries or all tests pass
 */

import path, { join } from "node:path";
import { type FixStory, convertFixStoryToUserStory, generateFixStories } from "../../acceptance";
import { getAgent } from "../../agents/registry";
import type { NaxConfig } from "../../config";
import { resolveModelForAgent } from "../../config";
import { loadConfigForWorkdir } from "../../config/loader";
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

export function isStubTestFile(content: string): boolean {
  // Detect skeleton stubs: expect(true).toBe(false) or expect(true).toBe(true) in test bodies
  return /expect\s*\(\s*true\s*\)\s*\.\s*toBe\s*\(\s*(?:false|true)\s*\)/.test(content);
}

/**
 * Detect test-level failure (P1-D, D2).
 *
 * Returns true when the failure is likely a test bug rather than implementation gaps:
 * - Test crashed with no ACs parsed ("AC-ERROR" sentinel)
 * - More than 80% of total ACs failed
 *
 * @param failedACs - ACs that failed in this run
 * @param totalACs - Total ACs across all non-fix stories
 */
export function isTestLevelFailure(failedACs: string[], totalACs: number): boolean {
  if (failedACs.includes("AC-ERROR")) return true;
  if (totalACs === 0) return false;
  return failedACs.length / totalACs > 0.8;
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

export const _acceptanceLoopDeps = { getAgent };

/** Generate and add fix stories to PRD */
async function generateAndAddFixStories(
  ctx: AcceptanceLoopContext,
  failures: { failedACs: string[]; testOutput: string },
  prd: PRD,
): Promise<FixStory[] | null> {
  const logger = getSafeLogger();
  const agent = (ctx.agentGetFn ?? _acceptanceLoopDeps.getAgent)(ctx.config.autoMode.defaultAgent);
  if (!agent) {
    logger?.error("acceptance", "Agent not found, cannot generate fix stories");
    return null;
  }
  const modelDef = resolveModelForAgent(
    ctx.config.models,
    ctx.config.autoMode.defaultAgent,
    ctx.config.analyze.model,
    ctx.config.autoMode.defaultAgent,
  );
  const testFilePath = ctx.featureDir ? path.join(ctx.featureDir, "acceptance.test.ts") : undefined;
  const fixStories = await generateFixStories(agent, {
    failedACs: failures.failedACs,
    testOutput: failures.testOutput,
    prd,
    specContent: await loadSpecContent(ctx.featureDir),
    workdir: ctx.workdir,
    modelDef,
    config: ctx.config,
    testFilePath,
    timeoutMs: ctx.config.acceptance?.timeoutMs,
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
  // PKG: resolve per-package effective config for fix stories (same as iteration-runner)
  const fixEffectiveConfig = story.workdir
    ? await loadConfigForWorkdir(join(ctx.workdir, ".nax", "config.json"), story.workdir)
    : ctx.config;
  const fixContext: PipelineContext = {
    config: ctx.config,
    effectiveConfig: fixEffectiveConfig,
    prd,
    story,
    stories: [story],
    routing: routing as RoutingResult,
    workdir: ctx.workdir,
    featureDir: ctx.featureDir,
    hooks: ctx.hooks,
    plugins: ctx.pluginRegistry,
    storyStartTime: new Date().toISOString(),
    agentGetFn: ctx.agentGetFn,
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
 * Back up and regenerate the acceptance test file (P1-D, D2).
 *
 * Steps:
 * 1. Copy acceptance.test.ts → acceptance.test.ts.bak
 * 2. Delete acceptance.test.ts
 * 3. Re-run acceptance-setup to generate fresh test
 *
 * @returns true if regeneration succeeded, false otherwise
 */
async function regenerateAcceptanceTest(testPath: string, acceptanceContext: PipelineContext): Promise<boolean> {
  const logger = getSafeLogger();
  const bakPath = `${testPath}.bak`;

  const content = await Bun.file(testPath).text();
  await Bun.write(bakPath, content);
  logger?.info("acceptance", `Backed up acceptance test -> ${bakPath}`);

  const { unlink } = await import("node:fs/promises");
  await unlink(testPath);

  const { acceptanceSetupStage } = await import("../../pipeline/stages/acceptance-setup");
  await acceptanceSetupStage.execute(acceptanceContext);

  if (!(await Bun.file(testPath).exists())) {
    logger?.error("acceptance", "Acceptance test regeneration failed — manual intervention required");
    return false;
  }

  logger?.info("acceptance", "Acceptance test regenerated successfully");
  return true;
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
    // Run acceptance validation — always from repo root (covers single repo + monorepo)
    const firstStory = prd.userStories[0];
    const acceptanceContext: PipelineContext = {
      config: ctx.config,
      effectiveConfig: ctx.config,
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
      agentGetFn: ctx.agentGetFn,
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

    // Check for stub test file before other checks
    if (ctx.featureDir) {
      const testPath = path.join(ctx.featureDir, "acceptance.test.ts");
      const testFile = Bun.file(testPath);
      if (await testFile.exists()) {
        const testContent = await testFile.text();
        if (isStubTestFile(testContent)) {
          logger?.warn("acceptance", "Stub tests detected — re-generating acceptance tests");
          const { unlink } = await import("node:fs/promises");
          await unlink(testPath);
          const { acceptanceSetupStage } = await import("../../pipeline/stages/acceptance-setup");
          await acceptanceSetupStage.execute(acceptanceContext);
          const newContent = await Bun.file(testPath).text();
          if (isStubTestFile(newContent)) {
            logger?.error(
              "acceptance",
              "Acceptance test generation failed after retry — manual implementation required",
            );
            return buildResult(false, prd, totalCost, iterations, storiesCompleted, prdDirty);
          }
          continue;
        }
      }
    }

    // P1-D / D2: Detect test-level failure — regenerate instead of fixing
    // Count total ACs from non-fix stories only
    const totalACs = prd.userStories
      .filter((s) => !s.id.startsWith("US-FIX-"))
      .flatMap((s) => s.acceptanceCriteria).length;

    if (ctx.featureDir && isTestLevelFailure(failures.failedACs, totalACs)) {
      logger?.warn(
        "acceptance",
        `Test-level failure detected (${failures.failedACs.length}/${totalACs} ACs failed) — regenerating acceptance test`,
      );
      const testPath = path.join(ctx.featureDir, "acceptance.test.ts");
      const testFile = Bun.file(testPath);
      if (await testFile.exists()) {
        const regenerated = await regenerateAcceptanceTest(testPath, acceptanceContext);
        if (!regenerated) {
          return buildResult(false, prd, totalCost, iterations, storiesCompleted, prdDirty);
        }
        continue; // retry with regenerated test
      }
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
