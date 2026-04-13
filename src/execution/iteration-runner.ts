/**
 * Iteration Runner (ADR-005, Phase 4)
 *
 * Runs a single story through the pipeline.
 * Extracted from sequential-executor.ts to slim it below 120 lines.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfigForWorkdir } from "../config/loader";
import { getLogger } from "../logger";
import { errorMessage } from "../utils/errors";
import type { StoryMetrics } from "../metrics";
import { runPipeline } from "../pipeline/runner";
import { defaultPipeline } from "../pipeline/stages";
import type { PipelineContext } from "../pipeline/types";
import { savePRD } from "../prd";
import type { PRD } from "../prd/types";
import { captureGitRef, isGitRefValid } from "../utils/git";
import { WorktreeManager } from "../worktree/manager";
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
  /** Set when finalAction === "decomposed" — number of sub-stories created */
  subStoryCount?: number;
}

export async function runIteration(
  ctx: SequentialExecutionContext,
  prd: PRD,
  selection: StorySelection,
  iterations: number,
  totalCost: number,
  allStoryMetrics: StoryMetrics[],
): Promise<IterationResult> {
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

  // EXEC-002: Resolve the effective workdir for this story.
  // In "worktree" mode, each story runs in its own git worktree at .nax-wt/<storyId>/.
  // In "shared" mode (default), use the project root as-is.
  let effectiveWorkdir = ctx.workdir;
  if (ctx.config.execution.storyIsolation === "worktree") {
    const worktreePath = join(ctx.workdir, ".nax-wt", story.id);
    const worktreeExists = _iterationRunnerDeps.existsSync(worktreePath);
    if (!worktreeExists) {
      // First attempt for this story — create a fresh worktree.
      await _iterationRunnerDeps.worktreeManager.ensureGitExcludes(ctx.workdir);
      await _iterationRunnerDeps.worktreeManager.create(ctx.workdir, story.id);
    }
    // Escalation reuse: if the worktree already exists (story retried in same worktree),
    // skip creation and continue in the existing worktree directory.
    effectiveWorkdir = worktreePath;
  }

  // BUG-114: Persist storyGitRef in prd.json so it survives crashes and restarts.
  // On the first attempt we capture HEAD and save it. On resume we reuse the stored
  // ref (after validating it still exists in git history), so semantic review always
  // diffs from the true start of this story regardless of how many times nax restarted.
  // EXEC-002: In worktree mode, capture/validate the ref inside the worktree (effectiveWorkdir).
  let storyGitRef: string | undefined;
  if (story.storyGitRef && (await isGitRefValid(effectiveWorkdir, story.storyGitRef))) {
    storyGitRef = story.storyGitRef;
  } else {
    storyGitRef = await captureGitRef(effectiveWorkdir);
    if (storyGitRef) {
      story.storyGitRef = storyGitRef;
      await savePRD(prd, ctx.prdPath);
    }
  }

  // BUG-067: Accumulate cost from all prior failed attempts (stored in priorFailures by handleTierEscalation)
  const accumulatedAttemptCost = (story.priorFailures || []).reduce((sum, f) => sum + (f.cost || 0), 0);

  // PKG-003: Resolve per-package effective config once per story (not per-stage)
  // Thread the CLI profile override through so --profile flags apply to per-package configs.
  const profileOverride =
    ctx.config.profile && ctx.config.profile !== "default" ? { profile: ctx.config.profile } : undefined;
  const effectiveConfig = story.workdir
    ? await _iterationRunnerDeps.loadConfigForWorkdir(
        join(ctx.workdir, ".nax", "config.json"),
        story.workdir,
        profileOverride,
      )
    : ctx.config;

  // EXEC-002: In worktree mode, effectiveWorkdir is the worktree root.
  // Monorepo subpackages (story.workdir) are resolved relative to the worktree root so
  // the agent operates in the correct package directory within the isolated worktree.
  const resolvedWorkdir =
    ctx.config.execution.storyIsolation === "worktree"
      ? story.workdir
        ? join(effectiveWorkdir, story.workdir)
        : effectiveWorkdir
      : story.workdir
        ? join(ctx.workdir, story.workdir)
        : ctx.workdir;

  const pipelineContext: PipelineContext = {
    config: effectiveConfig,
    rootConfig: ctx.config,
    prd,
    story,
    stories: storiesToExecute,
    routing,
    projectDir: ctx.workdir,
    workdir: resolvedWorkdir,
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

  // #410: Destroy reviewerSession on escalation — completion stage is bypassed when the pipeline
  // returns escalate, so we must clean up here to avoid leaking the ACP reviewer session.
  const reviewerSessionOnEscalate = pipelineResult.context.reviewerSession;
  if (pipelineResult.finalAction === "escalate" && reviewerSessionOnEscalate?.active) {
    try {
      await reviewerSessionOnEscalate.destroy();
    } catch (err) {
      getLogger()?.warn("iteration-runner", "Failed to destroy reviewerSession on escalation — continuing", {
        storyId: story.id,
        error: errorMessage(err),
      });
    }
  }

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
    statusWriter: ctx.statusWriter,
  };

  // Collect result from handlers BEFORE GC clearing — pipelineResult.context is the same
  // object as pipelineContext, so clearing agentResult before handlers read
  // agentResult.estimatedCost caused costDelta to always be 0. See #253.
  let iterResult: IterationResult;
  if (pipelineResult.success) {
    const r = await handlePipelineSuccess(handlerCtx, pipelineResult);
    iterResult = {
      prd: r.prd,
      storiesCompletedDelta: r.storiesCompletedDelta,
      costDelta: r.costDelta,
      prdDirty: r.prdDirty,
      finalAction: pipelineResult.finalAction,
    };
  } else {
    const r = await handlePipelineFailure(handlerCtx, pipelineResult);
    iterResult = {
      prd: r.prd,
      storiesCompletedDelta: 0,
      costDelta: r.costDelta,
      prdDirty: r.prdDirty,
      finalAction: pipelineResult.finalAction,
      reason: pipelineResult.reason,
      subStoryCount: pipelineResult.subStoryCount,
    };
  }

  // Release heavy context fields after handlers are done reading them.
  pipelineContext.agentResult = undefined;
  pipelineContext.prompt = undefined;
  pipelineContext.contextMarkdown = undefined;
  pipelineContext.builtContext = undefined;
  pipelineContext.verifyResult = undefined;
  pipelineContext.reviewResult = undefined;
  pipelineContext.constitution = undefined;

  return iterResult;
}

/**
 * Swappable dependencies for testing (avoids mock.module() which leaks in Bun 1.x).
 */
export const _iterationRunnerDeps = {
  loadConfigForWorkdir,
  existsSync,
  worktreeManager: new WorktreeManager(),
};
