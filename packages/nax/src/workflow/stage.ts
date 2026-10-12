/**
 * workflowStage (spec §5.2): one story through the A5 loop. Sets ctx.agentResult only
 * (P2-R1). completionStage still marks the story passed. Always returns continue, except
 * when the run is aborted (W-R3).
 */
import { errorMessage } from "@nathapp/nax-agent/internal";
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
    const { callCtx, dispose } = await _workflowStageDeps.buildWorkflowCallContext(ctx);
    try {
      const { sc, env } = await _workflowStageDeps.buildStoryEnv(ctx, callCtx);
      if (!env.resume) await _workflowStageDeps.writeBrief(sc);
      const outcome = await _workflowStageDeps.runStoryLoop(env);
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
    } finally {
      unsubscribe();
      await dispose();
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

async function appendLedgerSafe(ctx: PipelineContext, text: string): Promise<void> {
  try {
    await appendLedger(workflowRunDir(ctx.runtime.outputDir, ctx.prd.feature, ctx.runtime.runId), ctx.story.id, text);
  } catch {
    // the ledger is best-effort on the error path
  }
}
