/**
 * Iteration Runner (ADR-005, Phase 4)
 *
 * Runs a single story through the pipeline.
 * Extracted from sequential-executor.ts to slim it below 120 lines.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { profileOverrideFromConfig } from "../config";
import { loadConfigForWorkdir } from "../config/loader";
import { getLogger } from "../logger";
import type { StoryMetrics } from "../metrics";
import { runPipeline } from "../pipeline/runner";
import { defaultPipeline } from "../pipeline/stages";
import type { PipelineContext } from "../pipeline/types";
import { markStoryFailed, savePRD } from "../prd";
import type { PRD } from "../prd/types";
import { errorMessage } from "../utils/errors";
import { captureGitRef, isGitRefValid } from "../utils/git";
import { prepareWorktreeDependencies } from "../worktree/dependencies";
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

/** Drop per-story payloads after result handlers persist the data needed by later iterations. */
export function releaseHeavyPipelineContext(ctx: PipelineContext): void {
  ctx.agentResult = undefined;
  ctx.prompt = undefined;
  ctx.contextMarkdown = undefined;
  ctx.featureContextMarkdown = undefined;
  ctx.builtContext = undefined;
  ctx.contextBundle = undefined;
  ctx.constitution = undefined;
  ctx.acceptanceFailures = undefined;
  ctx.autofixPriorIterations = undefined;
  ctx.priorSemanticIterations = undefined;
  ctx.priorAdversarialIterations = undefined;
  ctx.reviewFindings = undefined;
  ctx.selfVerification = undefined;
  ctx.tddIsolations = undefined;
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

  // @design: BUG-114: Persist storyGitRef in prd.json so it survives crashes and restarts.
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

  // @design: BUG-067: Accumulate cost from all prior failed attempts (stored in priorFailures by handleTierEscalation)
  const accumulatedAttemptCost = (story.priorFailures || []).reduce((sum, f) => sum + (f.cost || 0), 0);

  // PKG-003: Resolve per-package effective config once per story (not per-stage)
  // Thread the CLI profile override through so --profile flags apply to per-package configs.
  // Use profileOverrideFromConfig (passes the round-trippable chain array, not the "a+b" composite).
  const profileOverride = profileOverrideFromConfig(ctx.config);
  const effectiveConfig = story.workdir
    ? await _iterationRunnerDeps.loadConfigForWorkdir(
        join(ctx.workdir, ".nax", "config.json"),
        story.workdir,
        profileOverride,
      )
    : ctx.config;

  let dependencyContext: import("../worktree/types").WorktreeDependencyContext | undefined;
  if (ctx.config.execution.storyIsolation === "worktree") {
    try {
      dependencyContext = await _iterationRunnerDeps.prepareWorktreeDependencies({
        projectRoot: ctx.workdir,
        worktreeRoot: effectiveWorkdir,
        storyId: story.id,
        storyWorkdir: story.workdir,
        config: effectiveConfig,
      });
    } catch (error) {
      markStoryFailed(prd, story.id, "dependency-prep", "worktree-dependencies", ctx.statusWriter);
      await savePRD(prd, ctx.prdPath);
      try {
        await _iterationRunnerDeps.worktreeManager.remove(ctx.workdir, story.id);
      } catch {
        // best-effort cleanup
      }
      return {
        prd,
        storiesCompletedDelta: 0,
        costDelta: 0,
        prdDirty: true,
        finalAction: "fail",
        reason: errorMessage(error),
      };
    }
  }

  // EXEC-002: In worktree mode, effectiveWorkdir is the worktree root.
  // Monorepo subpackages (story.workdir) are resolved relative to the worktree root so
  // the agent operates in the correct package directory within the isolated worktree.
  const resolvedWorkdir = dependencyContext?.cwd
    ? dependencyContext.cwd
    : ctx.config.execution.storyIsolation === "worktree"
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
    naxIgnoreIndex: ctx.naxIgnoreIndex,
    worktreeDependencyContext: dependencyContext,
    prdPath: ctx.prdPath,
    featureDir: ctx.featureDir,
    hooks: ctx.hooks,
    plugins: ctx.pluginRegistry,
    storyStartTime: new Date().toISOString(),
    storyGitRef: storyGitRef ?? undefined,
    interaction: ctx.interactionChain ?? undefined,
    agentGetFn: ctx.agentGetFn,
    abortSignal: ctx.abortSignal,
    sessionManager: ctx.sessionManager,
    agentManager: ctx.agentManager,
    pluginProviderCache: ctx.pluginProviderCache,
    accumulatedAttemptCost: accumulatedAttemptCost > 0 ? accumulatedAttemptCost : undefined,
    runtime: ctx.runtime,
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

  const pipelineResult = await _iterationRunnerDeps.runPipeline(defaultPipeline, pipelineContext, ctx.eventEmitter);

  // Tear down warm story sessions (implementer + per-role) on escalation so the
  // next attempt opens fresh ACP sessions. Without this, warm-lifetime sessions
  // stay in SessionManager._liveHandles / persist as descriptors, and the next
  // openSession call resumes the prior conversation. The session name (used as
  // the prompt-audit filename prefix) is unchanged — only the underlying ACP
  // session is recreated, so audit correlation by storyId+role is preserved.
  if (pipelineResult.finalAction === "escalate" && ctx.sessionManager) {
    const sessionManager = ctx.sessionManager;
    const liveStorySessions = sessionManager
      .getForStory(story.id)
      .filter((desc) => desc.handle && (desc.state === "RUNNING" || desc.state === "CREATED"));
    for (const desc of liveStorySessions) {
      if (!desc.handle) continue;
      const live = sessionManager.getLiveHandle(desc.handle);
      if (!live) continue;
      try {
        await sessionManager.closeSession(live);
      } catch (err) {
        getLogger().warn("iteration-runner", "Failed to close warm session on escalation — continuing", {
          storyId: story.id,
          sessionName: desc.handle ?? "(no handle)",
          role: desc.role,
          error: errorMessage(err),
        });
      }
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
    agentManager: ctx.agentManager,
    sessionManager: ctx.sessionManager,
    runtime: ctx.runtime,
    abortSignal: ctx.abortSignal,
  };

  // Collect result from handlers BEFORE GC clearing — pipelineResult.context is the same
  // object as pipelineContext, so clearing agentResult before handlers read
  // agentResult.estimatedCostUsd caused costDelta to always be 0. See #253.
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

  releaseHeavyPipelineContext(pipelineContext);

  return iterResult;
}

/**
 * Swappable dependencies for testing (avoids mock.module() which leaks in Bun 1.x).
 */
export const _iterationRunnerDeps = {
  loadConfigForWorkdir,
  prepareWorktreeDependencies,
  runPipeline,
  existsSync,
  worktreeManager: new WorktreeManager(),
};
