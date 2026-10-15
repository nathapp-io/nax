/** Implementer turns (spec §6 steps 2, 5): the first turn, fix rounds and advisor answers, all on workflowImplementOp. */
import { errorMessage } from "@nathapp/nax-agent/internal";
import type { ConfiguredModel } from "@/config";
import { getSafeLogger } from "@/logger";
import { workflowImplementOp } from "@/operations";
import {
  buildWorkflowAnswerPrompt,
  buildWorkflowFixPrompt,
  buildWorkflowImplementPrompt,
  buildWorkflowRestartPrompt,
} from "@/prompts";
import { fixModelFor } from "./fix-round";
import { listUncommitted } from "./git";
import { closeImplementerSession } from "./sessions";
import { _workflowDeps, type StepContext } from "./step-context";
import type { ImplementerReply, WorkflowFinding } from "./types";

export type ImplementTurn =
  | { readonly kind: "implement" }
  | {
      /** US-001: a no-work turn's restart. `fresh` closes the session and re-sends the full implement prompt. */
      readonly kind: "restart";
      readonly fresh: boolean;
      readonly stepUps: number;
    }
  | { readonly kind: "answer"; readonly text: string; readonly stepUps: number; readonly limit: "implement" | "fix" }
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
  const paths = { storyId: sc.story.id, briefPath: sc.briefPath, reportPath: sc.reportPath };
  // US-009: a declared e2e command is the only way for an agent to run browser e2e (the Bash sandbox
  // cannot launch a browser), so both full implement prompts say how. The warm restart keeps its
  // one-line reminder and gains nothing.
  const e2eGate = sc.config.quality?.commands?.e2e !== undefined;
  if (turn.kind === "implement") return buildWorkflowImplementPrompt({ ...paths, e2eGate });
  // US-001: the warm restart keeps the session, so it gets the short prompt; the fresh one starts over in full.
  if (turn.kind === "restart")
    return turn.fresh ? buildWorkflowImplementPrompt({ ...paths, e2eGate }) : buildWorkflowRestartPrompt(paths);
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

/** The model a turn steps up to (spec §4 "Implementer model"); undefined keeps the story's routed model. */
export function implementerModelFor(sc: StepContext, turn: ImplementTurn): ConfiguredModel | undefined {
  const stepUps = turn.kind === "implement" ? 0 : turn.stepUps;
  return stepUps > 0 ? fixModelFor(sc.story, sc.tierOrder, stepUps) : undefined;
}

/** A fresh turn (fix or restart) must close the warm session first, or it would not be fresh (P2-R5). */
function closesSessionFirst(turn: ImplementTurn): boolean {
  return (turn.kind === "restart" || turn.kind === "fix") && turn.fresh;
}

/**
 * The edits a finished turn left behind. Fail-open on purpose (nax#2550): `listUncommitted` throws when
 * the repo cannot be read, and the auto-commit is best effort, so an unreadable tree skips it with a
 * warning rather than failing a turn that did its work. The gates and `publish`'s clean-tree check
 * still see the tree.
 */
async function dirtyAfterTurn(sc: StepContext): Promise<string[]> {
  try {
    return await listUncommitted(sc.projectDir);
  } catch (err) {
    getSafeLogger()?.warn("workflow", "Could not read the working tree after the turn; skipping the auto-commit", {
      storyId: sc.story.id,
      error: errorMessage(err),
    });
    return [];
  }
}

export async function runImplementerTurn(sc: StepContext, turn: ImplementTurn): Promise<ImplementOutcome> {
  if (closesSessionFirst(turn)) await closeImplementerSession(sc.sessionManager, sc.story.id);
  const model = implementerModelFor(sc, turn);
  const timeoutMs =
    turn.kind === "implement" || turn.kind === "restart" || (turn.kind === "answer" && turn.limit === "implement")
      ? sc.workflow.timeouts.implementMs
      : sc.workflow.timeouts.fixMs;
  let reply: ImplementerReply;
  try {
    reply = await _workflowDeps.callOp(sc.callCtx, workflowImplementOp, {
      story: sc.story,
      prompt: promptFor(sc, turn),
      reportPath: sc.reportPath,
      ...(model !== undefined ? { model } : {}),
      timeoutMs,
    });
  } catch (err) {
    if (sc.runSignal?.aborted) throw err;
    return { failure: errorMessage(err), autoCommitted: false };
  }
  if (reply.failure) return { reply, failure: reply.failure, autoCommitted: false };
  if (reply.interrupted) return { reply, autoCommitted: false };
  const dirty = await dirtyAfterTurn(sc);
  if (dirty.length === 0) return { reply, autoCommitted: false };
  await _workflowDeps.autoCommitIfDirty(sc.projectDir, "workflow", "wf-implementer", sc.story.id, undefined, sc.dryRun);
  return { reply, autoCommitted: true };
}
