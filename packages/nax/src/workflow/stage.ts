/**
 * workflowStage (spec §5.2): one story through the A5 loop. Sets ctx.agentResult only
 * (P2-R1). completionStage still marks the story passed. Always returns continue, except
 * when the run is aborted (W-R3).
 */
import { errorMessage } from "@nathapp/nax-agent/internal";
import { NaxError } from "@/errors";
import { getLogger } from "@/logger";
import type { PipelineContext, PipelineStage, StageResult } from "@/pipeline/types";
import { writeBrief } from "./brief";
import { buildWorkflowCallContext } from "./call-context";
import { appendLedger } from "./ledger";
import { workflowRunDir } from "./paths";
import { buildStoryEnv } from "./stage-env";
import { runStoryLoop } from "./story-loop";

export const _workflowStageDeps = { buildWorkflowCallContext, buildStoryEnv, runStoryLoop, writeBrief };

export const workflowStage: PipelineStage = {
  name: "workflow",
  enabled: () => true,

  async execute(ctx: PipelineContext): Promise<StageResult> {
    const logger = getLogger();
    // Batched stories must never reach this stage (completionStage would pass the unimplemented ones).
    if (ctx.stories.length > 1) {
      throw new NaxError(
        `workflowStage received a batch of ${ctx.stories.length} stories; workflow mode runs one story at a time`,
        "WORKFLOW_BATCH_UNREACHABLE",
        { stage: "workflow", storyId: ctx.story.id, batchSize: ctx.stories.length },
      );
    }
    const started = Date.now();
    let costUsd = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    const unsubscribe =
      ctx.runtime?.dispatchEvents?.onDispatch((event) => {
        costUsd += event.exactCostUsd ?? event.estimatedCostUsd ?? 0;
        inputTokens += event.tokenUsage?.inputTokens ?? 0;
        outputTokens += event.tokenUsage?.outputTokens ?? 0;
      }) ?? (() => {});
    let dispose: (() => Promise<void>) | null = null;
    let closeOnError: ((reason: string) => Promise<void>) | null = null;
    try {
      const built = await _workflowStageDeps.buildWorkflowCallContext(ctx);
      dispose = built.dispose;
      const { callCtx } = built;
      const storyEnv = await _workflowStageDeps.buildStoryEnv(ctx, callCtx);
      const { sc, env } = storyEnv;
      closeOnError = storyEnv.closeOnError;
      // A resumed story keeps its prior brief (copied into this run's dir); a missing one is rewritten.
      if (!env.resume || !(await Bun.file(sc.briefPath).exists())) await _workflowStageDeps.writeBrief(sc);
      const outcome = await _workflowStageDeps.runStoryLoop(env);
      // An abort swallowed inside a step (e.g. a gate) must not close the story as passed.
      if (ctx.abortSignal?.aborted) throw abortError(ctx);
      logger.info("workflow", "Story closed", {
        storyId: ctx.story.id,
        state: outcome.state,
        reason: outcome.reason,
        rounds: outcome.rounds,
      });
    } catch (err) {
      if (ctx.abortSignal?.aborted) throw err;
      logger.error("workflow", "Workflow loop error — story closed gate-open", {
        storyId: ctx.story.id,
        error: errorMessage(err),
      });
      await appendLedgerSafe(ctx, `complete-gate-open (workflow error: ${errorMessage(err)})`);
      if (closeOnError) await closeOnError(errorMessage(err));
    } finally {
      unsubscribe();
      if (dispose) await dispose();
    }
    ctx.agentResult = {
      success: true,
      estimatedCostUsd: costUsd,
      rateLimited: false,
      output: "",
      exitCode: 0,
      durationMs: Date.now() - started,
      tokenUsage: { inputTokens, outputTokens },
    };
    return { action: "continue" };
  },
};

function abortError(ctx: PipelineContext): NaxError {
  return new NaxError("Run aborted during the workflow story loop", "WORKFLOW_ABORTED", {
    stage: "workflow",
    storyId: ctx.story.id,
  });
}

async function appendLedgerSafe(ctx: PipelineContext, text: string): Promise<void> {
  try {
    await appendLedger(workflowRunDir(ctx.runtime.outputDir, ctx.prd.feature, ctx.runtime.runId), ctx.story.id, text);
  } catch (err) {
    getLogger().debug("workflow", "Ledger append failed on the error path", {
      storyId: ctx.story.id,
      error: errorMessage(err),
    });
  }
}
