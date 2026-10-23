/** Implementer turns (spec §6 steps 2, 5): the first turn, fix rounds and advisor answers, all on workflowImplementOp. */
import { errorMessage } from "@nathapp/nax-agent/internal";
import type { ConfiguredModel } from "@/config";
import { getSafeLogger } from "@/logger";
import { workflowImplementOp } from "@/operations";
import {
  buildWorkflowAnswerPrompt,
  buildWorkflowContinuePrompt,
  buildWorkflowFixPrompt,
  buildWorkflowImplementPrompt,
  buildWorkflowReportPrompt,
  buildWorkflowRestartPrompt,
} from "@/prompts";
import { fixModelFor } from "./fix-round";
import { listUncommitted, readHead } from "./git";
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
      /**
       * US-004: the turn that tells the still-warm session it was cut off at its step limit. It runs
       * at `budgetMultiplier` of the limit it hit and keeps its origin's step-up and session.
       */
      readonly kind: "continue";
      readonly limit: "implement" | "fix";
      readonly stepUps: number;
      readonly attempt: number;
      readonly maxAttempts: number;
      /** The files changed since the story base; `undefined` when the list could not be read. */
      readonly changedFiles?: readonly string[];
    }
  | {
      /** US-004: the short report-only turn sent when the implementer's `report.md` is missing. */
      readonly kind: "report";
      readonly stepUps: number;
    }
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

/** The step limit a continue turn was cut off by: the implement limit or the fix limit, per its origin. */
function continueLimitMs(sc: StepContext, turn: Extract<ImplementTurn, { kind: "continue" }>): number {
  return turn.limit === "implement" ? sc.workflow.timeouts.implementMs : sc.workflow.timeouts.fixMs;
}

/** Whole minutes for a prompt, never 0: "you have up to 0 minutes" tells the agent nothing (US-004). */
function minutes(ms: number): number {
  return Math.max(1, Math.round(ms / 60_000));
}

/** US-004: a continue runs at `budgetMultiplier` of the limit it hit; a report turn at `reportMs`. */
function turnTimeoutMs(sc: StepContext, turn: ImplementTurn): number {
  if (turn.kind === "report") return sc.workflow.timeouts.reportMs;
  if (turn.kind === "continue")
    return Math.floor(continueLimitMs(sc, turn) * sc.workflow.interruptRetry.budgetMultiplier);
  return turn.kind === "implement" || turn.kind === "restart" || (turn.kind === "answer" && turn.limit === "implement")
    ? sc.workflow.timeouts.implementMs
    : sc.workflow.timeouts.fixMs;
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
  if (turn.kind === "report") return buildWorkflowReportPrompt({ storyId: sc.story.id, reportPath: sc.reportPath });
  // US-004: the continue says how long the turn ran and which files changed; it never resends the brief.
  if (turn.kind === "continue")
    return buildWorkflowContinuePrompt({
      storyId: sc.story.id,
      reportPath: sc.reportPath,
      limitMinutes: minutes(continueLimitMs(sc, turn)),
      budgetMinutes: minutes(turnTimeoutMs(sc, turn)),
      attempt: turn.attempt,
      maxAttempts: turn.maxAttempts,
      ...(turn.changedFiles !== undefined ? { changedFiles: turn.changedFiles } : {}),
    });
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

/**
 * US-004: the best-effort auto-commit of whatever the last turn left behind, shared by
 * `runImplementerTurn` and the interrupt fallback. True only when a commit was actually created.
 *
 * F1 (US-007): `autoCommitIfDirty` is fail-open and returns *without* committing under a dry run, a
 * rejected workdir, a failed `git add` or an empty staging set, so its return says nothing about the
 * tree. The answer is therefore read off HEAD moving — and an unreadable HEAD reads as "no commit",
 * because claiming a commit that cannot be proved is what told the story reviewer its edits were
 * committed while they still sat on disk. A failing commit is a warning, never a failed turn: the
 * edits are still on disk, and the gates and `publish`'s clean-tree check still see them.
 */
export async function autoCommitTurnEdits(sc: StepContext): Promise<boolean> {
  const dirty = await dirtyAfterTurn(sc);
  if (dirty.length === 0) return false;
  const before = await headOrUndefined(sc);
  try {
    await _workflowDeps.autoCommitIfDirty(
      sc.projectDir,
      "workflow",
      "wf-implementer",
      sc.story.id,
      undefined,
      sc.dryRun,
    );
  } catch (err) {
    getSafeLogger()?.warn("workflow", "Auto-commit of the implementer's edits failed; leaving them uncommitted", {
      storyId: sc.story.id,
      error: errorMessage(err),
    });
    return false;
  }
  if (before === undefined) return false;
  const after = await headOrUndefined(sc);
  return after !== undefined && after !== before;
}

/** HEAD's sha, or `undefined` when it cannot be read — the caller then never claims a commit. */
async function headOrUndefined(sc: StepContext): Promise<string | undefined> {
  try {
    return await readHead(sc.projectDir);
  } catch {
    // A repo with no readable HEAD cannot prove a commit; the auto-commit is best-effort, so say nothing.
    return undefined;
  }
}

export async function runImplementerTurn(sc: StepContext, turn: ImplementTurn): Promise<ImplementOutcome> {
  if (closesSessionFirst(turn)) await closeImplementerSession(sc.sessionManager, sc.story.id);
  const model = implementerModelFor(sc, turn);
  let reply: ImplementerReply;
  try {
    reply = await _workflowDeps.callOp(sc.callCtx, workflowImplementOp, {
      story: sc.story,
      prompt: promptFor(sc, turn),
      reportPath: sc.reportPath,
      ...(model !== undefined ? { model } : {}),
      timeoutMs: turnTimeoutMs(sc, turn),
    });
  } catch (err) {
    if (sc.runSignal?.aborted) throw err;
    return { failure: errorMessage(err), autoCommitted: false };
  }
  if (reply.failure) return { reply, failure: reply.failure, autoCommitted: false };
  if (reply.interrupted) return { reply, autoCommitted: false };
  return { reply, autoCommitted: await autoCommitTurnEdits(sc) };
}
