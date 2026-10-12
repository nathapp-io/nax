/** Implementer turns (spec §6 steps 2, 5): the first turn, fix rounds and advisor answers, all on workflowImplementOp. */
import { errorMessage } from "@nathapp/nax-agent/internal";
import { workflowImplementOp } from "@/operations";
import { buildWorkflowAnswerPrompt, buildWorkflowFixPrompt, buildWorkflowImplementPrompt } from "@/prompts";
import { fixModelFor } from "./fix-round";
import { listUncommitted } from "./git";
import { closeImplementerSession } from "./sessions";
import { _workflowDeps, type StepContext } from "./step-context";
import type { ImplementerReply, WorkflowFinding } from "./types";

export type ImplementTurn =
  | { readonly kind: "implement" }
  | { readonly kind: "answer"; readonly text: string }
  | {
      readonly kind: "fix";
      readonly round: number;
      readonly fresh: boolean;
      readonly stepUps: number;
      readonly findings: readonly WorkflowFinding[];
      readonly uncommitted: readonly string[];
    };

export interface ImplementOutcome {
  readonly reply?: ImplementerReply;
  readonly failure?: string;
  readonly autoCommitted: boolean;
}

function promptFor(sc: StepContext, turn: ImplementTurn): string {
  if (turn.kind === "implement") {
    return buildWorkflowImplementPrompt({ storyId: sc.story.id, briefPath: sc.briefPath, reportPath: sc.reportPath });
  }
  if (turn.kind === "answer") return buildWorkflowAnswerPrompt(turn.text);
  return buildWorkflowFixPrompt({
    mode: turn.fresh ? "fresh" : "warm",
    round: turn.round,
    maxRounds: sc.workflow.maxFixRounds,
    priorRounds: turn.round - 1,
    findings: turn.findings,
    briefPath: sc.briefPath,
    reportPath: sc.reportPath,
    uncommittedFiles: turn.uncommitted,
  });
}

export async function runImplementerTurn(sc: StepContext, turn: ImplementTurn): Promise<ImplementOutcome> {
  if (turn.kind === "fix" && turn.fresh) await closeImplementerSession(sc.sessionManager, sc.story.id);
  const model = turn.kind === "fix" ? fixModelFor(sc.story, sc.tierOrder, turn.stepUps) : undefined;
  let reply: ImplementerReply;
  try {
    reply = await _workflowDeps.callOp(sc.callCtx, workflowImplementOp, {
      story: sc.story,
      prompt: promptFor(sc, turn),
      ...(model !== undefined ? { model } : {}),
      timeoutMs: turn.kind === "implement" ? sc.workflow.timeouts.implementMs : sc.workflow.timeouts.fixMs,
    });
  } catch (err) {
    if (sc.runSignal?.aborted) throw err;
    return { failure: errorMessage(err), autoCommitted: false };
  }
  if (reply.failure) return { reply, failure: reply.failure, autoCommitted: false };
  if (reply.interrupted) return { reply, autoCommitted: false };
  const dirty = await listUncommitted(sc.projectDir);
  if (dirty.length === 0) return { reply, autoCommitted: false };
  await _workflowDeps.autoCommitIfDirty(sc.projectDir, "workflow", "wf-implementer", sc.story.id, undefined, sc.dryRun);
  return { reply, autoCommitted: true };
}
