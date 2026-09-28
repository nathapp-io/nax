/**
 * Per-iteration dispatch phases for `executeUnified` (./unified-executor.ts).
 *
 * Split out during the complexity drain (docs/plans/STATUS-complexity-drain.md
 * A1): `executeUnified`'s while-loop body scored 165 as one function covering
 * three dispatch shapes (many-story parallel batch, single-story-in-batch,
 * sequential). Each shape is its own function, taking the loop's mutable state
 * as an explicit `LoopState` object and returning the next one. A pure
 * extraction: no dispatch rule changed.
 *
 * This file holds the shared types/helpers plus sequential dispatch; the two
 * parallel-batch shapes live in ./unified-executor-parallel-dispatch.ts (kept
 * separate so neither file grows past the 600-line gate).
 *
 * `_unifiedExecutorDeps` (the test-injection seam) stays in unified-executor.ts
 * — these functions take the seam's functions as `deps` parameters instead of
 * importing the seam directly, which would cycle back to unified-executor.ts.
 */

import { pipelineEventBus } from "@/pipeline/event-bus";
import { getSafeLogger } from "../logger";
import type { StoryMetrics } from "../metrics";
import { isStalled, loadPRD } from "../prd";
import type { PRD } from "../prd/types";
import { cancellableDelay } from "../utils/bun-deps";
import { errorMessage } from "../utils/errors";
import type { NaxIgnoreIndex } from "../utils/path-filters";
import { precomputeBatchPlan } from "./batching";
import { enforceCostLimit } from "./cost-guard";
import { maybeSendCostWarning } from "./cost-warning";
import type { preIterationTierCheck } from "./escalation";
import { agentFor, type ExitReason, type SequentialExecutionContext } from "./executor-types";
import { getAllReadyStories } from "./helpers";
import type { runIteration } from "./iteration-runner";
import { reconcileRunCost } from "./run-cost-reconcile";
import { closeStorySessions } from "./session-manager-runtime";
import { logStoryStart } from "./story-announce";
import { selectNextStories } from "./story-selector";

export const TERMINAL_ACTIONS = new Set(["fail", "skip", "pause"]);

/** The loop-scoped fields every dispatch phase reads and returns an updated copy of. */
export interface LoopState {
  prd: PRD;
  prdDirty: boolean;
  totalCost: number;
  storiesCompleted: number;
  lastStoryId: string | null;
  warningSent: boolean;
}

export type DispatchStep =
  | { action: "continue"; state: LoopState }
  | { action: "return"; state: LoopState; exitReason: ExitReason }
  /** Only `runParallelDispatch` returns this — batch.length === 0, fall through to sequential dispatch. */
  | { action: "fallthrough"; state: LoopState };

export interface DispatchPhaseParams {
  ctx: SequentialExecutionContext;
  state: LoopState;
  iterations: number;
  allStoryMetrics: StoryMetrics[];
  naxIgnoreIndex: NaxIgnoreIndex;
  costLimit: number;
  /** Publishes the reconciled run cost the moment it changes, for the heartbeat. */
  reportCost: (totalCost: number) => void;
}

export interface SequentialDispatchDeps {
  runIteration: typeof runIteration;
  preIterationTierCheck: typeof preIterationTierCheck;
}

/** Mirrors executeUnified's own terminal-close rule for a finished story. */
export async function closeStoryIfTerminal(
  ctx: SequentialExecutionContext,
  storyId: string,
  iter: { storiesCompletedDelta: number; finalAction?: string },
): Promise<void> {
  const isTerminal = iter.storiesCompletedDelta > 0 || (iter.finalAction && TERMINAL_ACTIONS.has(iter.finalAction));
  if (!isTerminal) return;
  if (ctx.sessionManager) await closeStorySessions(ctx.sessionManager, storyId, ctx.agentGetFn);
  ctx.agentManager?.resetTransientUnavailable?.();
}

/**
 * BUG-2 fix: treat an aborted delay as a clean stop. Without this, the
 * rejection escapes executeUnified and races the signal handler's own
 * teardown + process.exit(130) (see docs/20260816-review-since-0.80.0-canary.3.md).
 */
export async function runIterationDelay(
  ctx: SequentialExecutionContext,
  iterations: number,
): Promise<{ aborted: boolean }> {
  try {
    await cancellableDelay(ctx.config.execution.iterationDelayMs, ctx.runtime.signal);
    return { aborted: false };
  } catch (err) {
    if (ctx.runtime.signal.aborted) {
      getSafeLogger()?.info("execution", "Iteration delay aborted — exiting cleanly", {
        iterations,
        reason: errorMessage(err),
      });
      return { aborted: true };
    }
    throw err;
  }
}

/**
 * Sequential single-story dispatch — the fallback path when parallel dispatch
 * is off, or its batch selector returned nothing (`batch.length === 0`).
 */
export async function runSequentialDispatch(
  params: DispatchPhaseParams,
  deps: SequentialDispatchDeps,
): Promise<DispatchStep> {
  const { ctx, state, iterations, allStoryMetrics } = params;
  let { prd, totalCost, storiesCompleted, prdDirty } = state;
  let warningSent = state.warningSent;
  let lastStoryId = state.lastStoryId;

  const currentBatchPlan = ctx.useBatch ? precomputeBatchPlan(getAllReadyStories(prd), 4) : ctx.batchPlan;
  const selected = selectNextStories(prd, ctx.config, currentBatchPlan, 0, lastStoryId, ctx.useBatch);
  if (!selected) return { action: "return", state, exitReason: "no-stories" };
  const { selection } = selected;
  if (!selection) return { action: "return", state, exitReason: "no-stories" }; // defensive: type contract guarantees non-null when selected is non-null
  lastStoryId = selection.story.id; // BUG-39: unconditional (was !ctx.useBatch-gated)

  const costLimit = params.costLimit;
  {
    const seqCostCheck = await enforceCostLimit(ctx, totalCost, costLimit, selection.story.id);
    if (seqCostCheck.stop) {
      return {
        action: "return",
        state: { prd, prdDirty, totalCost, storiesCompleted, lastStoryId, warningSent },
        exitReason: "cost-limit",
      };
    }
  }

  const modelTier = selection.routing.modelTier;
  const seqAgent = agentFor(selection.story, ctx);
  pipelineEventBus.emit({
    type: "story:started",
    storyId: selection.story.id,
    story: {
      id: selection.story.id,
      title: selection.story.title,
      status: selection.story.status,
      attempts: selection.story.attempts,
    },
    workdir: ctx.workdir,
    modelTier,
    agent: seqAgent,
    iteration: iterations,
  });
  const seqPre = await deps.preIterationTierCheck(
    selection.story,
    selection.routing,
    ctx.config,
    prd,
    ctx.prdPath,
    ctx.featureDir,
    ctx.hooks,
    ctx.feature,
    totalCost,
    ctx.workdir,
    ctx.runtime,
  );
  if (seqPre.shouldSkipIteration) {
    if (seqPre.prd.userStories.find((s) => s.id === selection.story.id)?.status === "failed") lastStoryId = null; // BUG-39
    return {
      action: "continue",
      state: { prd: seqPre.prd, prdDirty: seqPre.prdDirty, totalCost, storiesCompleted, lastStoryId, warningSent },
    };
  }

  // #1653: announced only after the pre-check clears the attempt to run.
  logStoryStart(prd, selection.story, {
    complexity: selection.routing.complexity ?? "unknown",
    modelTier,
    agent: seqAgent,
  });

  const iter = await deps.runIteration(ctx, prd, selection, iterations, totalCost, allStoryMetrics);
  await pipelineEventBus.drain();
  prd = iter.prd;
  storiesCompleted += iter.storiesCompletedDelta;
  totalCost = reconcileRunCost(totalCost + iter.costDelta, ctx.runtime.costAggregator);
  params.reportCost(totalCost);
  prdDirty = iter.prdDirty;
  await closeStoryIfTerminal(ctx, selection.story.id, iter);
  warningSent = await maybeSendCostWarning(ctx, totalCost, costLimit, warningSent); // #2006: totalCost is now the reconciled max — same reading as the guard.

  if (iter.prdDirty) {
    prd = await loadPRD(ctx.prdPath);
    prdDirty = false;
  }
  ctx.statusWriter.setPrd(prd);
  ctx.statusWriter.setCurrentStory(null);
  await ctx.statusWriter.update(totalCost, iterations);

  if (isStalled(prd, ctx.config.execution.rectification?.maxAttemptsTotal)) {
    pipelineEventBus.emit({ type: "run:paused", reason: "All remaining stories blocked", cost: totalCost });
    return {
      action: "return",
      state: { prd, prdDirty, totalCost, storiesCompleted, lastStoryId, warningSent },
      exitReason: "stalled",
    };
  }
  // BUG-2 fix: an aborted delay is a clean stop, not an exception that escapes into the runner's finally.
  const delayOutcome = await runIterationDelay(ctx, iterations);
  if (delayOutcome.aborted) {
    return {
      action: "return",
      state: { prd, prdDirty, totalCost, storiesCompleted, lastStoryId, warningSent },
      exitReason: "aborted",
    };
  }

  return { action: "continue", state: { prd, prdDirty, totalCost, storiesCompleted, lastStoryId, warningSent } };
}
