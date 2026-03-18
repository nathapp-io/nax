/**
 * Iteration Runner (ADR-005, Phase 4)
 *
 * Runs a single story through the pipeline.
 * Extracted from sequential-executor.ts to slim it below 120 lines.
 */

import { join } from "node:path";
import { loadConfigForWorkdir } from "../config/loader";
import { getSafeLogger } from "../logger";
import type { StoryMetrics } from "../metrics";
import { runPipeline } from "../pipeline/runner";
import type { PipelineRunResult } from "../pipeline/runner";
import { defaultPipeline } from "../pipeline/stages";
import type { PipelineContext } from "../pipeline/types";
import type { PRD } from "../prd/types";
import { captureGitRef } from "../utils/git";
import { handleDryRun } from "./dry-run";
import type { SequentialExecutionContext } from "./executor-types";
import { handlePipelineFailure, handlePipelineSuccess } from "./pipeline-result-handler";
import type { StorySelection } from "./story-selector";

export interface IterationResult {
  prd: PRD;
  storiesCompletedDelta: number;
  costDelta: number;
  prdDirty: boolean;
  finalAction?: string;
  reason?: string;
}

export async function runIteration(
  ctx: SequentialExecutionContext,
  prd: PRD,
  selection: StorySelection,
  iterations: number,
  totalCost: number,
  allStoryMetrics: StoryMetrics[],
): Promise<IterationResult> {
  const logger = getSafeLogger();
  const { story, storiesToExecute, routing, isBatchExecution } = selection;

  if (ctx.dryRun) {
    const dryRunResult = await handleDryRun({
      prd,
      prdPath: ctx.prdPath,
      storiesToExecute,
      routing,
      statusWriter: ctx.statusWriter,
      pluginRegistry: ctx.pluginRegistry,
      runId: ctx.runId,
      totalCost,
      iterations,
    });
    return {
      prd,
      storiesCompletedDelta: dryRunResult.storiesCompletedDelta,
      costDelta: 0,
      prdDirty: dryRunResult.prdDirty,
    };
  }

  const storyStartTime = Date.now();
  const storyGitRef = await captureGitRef(ctx.workdir);

  // BUG-067: Accumulate cost from all prior failed attempts (stored in priorFailures by handleTierEscalation)
  const accumulatedAttemptCost = (story.priorFailures || []).reduce((sum, f) => sum + (f.cost || 0), 0);

  // PKG-003: Resolve per-package effective config once per story (not per-stage)
  const effectiveConfig = story.workdir
    ? await _iterationRunnerDeps.loadConfigForWorkdir(join(ctx.workdir, "nax", "config.json"), story.workdir)
    : ctx.config;

  const pipelineContext: PipelineContext = {
    config: ctx.config,
    effectiveConfig,
    prd,
    story,
    stories: storiesToExecute,
    routing,
    workdir: ctx.workdir,
    prdPath: ctx.prdPath,
    featureDir: ctx.featureDir,
    hooks: ctx.hooks,
    plugins: ctx.pluginRegistry,
    storyStartTime: new Date().toISOString(),
    storyGitRef: storyGitRef ?? undefined,
    interaction: ctx.interactionChain ?? undefined,
    agentGetFn: ctx.agentGetFn,
    pidRegistry: ctx.pidRegistry,
    accumulatedAttemptCost: accumulatedAttemptCost > 0 ? accumulatedAttemptCost : undefined,
  };

  ctx.statusWriter.setPrd(prd);
  ctx.statusWriter.setCurrentStory({
    storyId: story.id,
    title: story.title,
    complexity: routing.complexity,
    tddStrategy: routing.testStrategy,
    model: routing.modelTier,
    attempt: (story.attempts ?? 0) + 1,
    phase: "routing",
  });
  await ctx.statusWriter.update(totalCost, iterations);

  const pipelineResult = await runPipeline(defaultPipeline, pipelineContext, ctx.eventEmitter);
  const currentPrd = pipelineResult.context.prd;

  const handlerCtx = {
    config: ctx.config,
    prd: currentPrd,
    prdPath: ctx.prdPath,
    workdir: ctx.workdir,
    featureDir: ctx.featureDir,
    hooks: ctx.hooks,
    feature: ctx.feature,
    totalCost,
    startTime: ctx.startTime,
    runId: ctx.runId,
    pluginRegistry: ctx.pluginRegistry,
    story,
    storiesToExecute,
    routing: pipelineResult.context.routing ?? routing,
    isBatchExecution,
    allStoryMetrics,
    storyGitRef,
    interactionChain: ctx.interactionChain,
    storyStartTime,
  };

  if (pipelineResult.success) {
    const r = await handlePipelineSuccess(handlerCtx, pipelineResult);
    return {
      prd: r.prd,
      storiesCompletedDelta: r.storiesCompletedDelta,
      costDelta: r.costDelta,
      prdDirty: r.prdDirty,
      finalAction: pipelineResult.finalAction,
    };
  }
  const r = await handlePipelineFailure(handlerCtx, pipelineResult);
  return {
    prd: r.prd,
    storiesCompletedDelta: 0,
    costDelta: r.costDelta,
    prdDirty: r.prdDirty,
    finalAction: pipelineResult.finalAction,
    reason: pipelineResult.reason,
  };
}

/**
 * Swappable dependencies for testing (avoids mock.module() which leaks in Bun 1.x).
 */
export const _iterationRunnerDeps = {
  loadConfigForWorkdir,
};
