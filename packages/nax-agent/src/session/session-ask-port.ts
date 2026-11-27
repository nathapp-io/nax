/**
 * The session's ask port (S4 spec 5.1): approvals and questions any backend
 * raises, on top of the pending-ask table. A request needs a running turn: its
 * events go on that turn's stream and its turn signal settles it. Profile
 * auto-decisions and informational questions are emitted, never queued.
 */
import { NaxError } from "#src/infra/nax-error";
import { _agentSessionDeps } from "./agent-session-deps.ts";
import type { AnswerReply, SessionEventBody } from "./agent-session-types.ts";
import {
  type ChoiceQuestion,
  formatChoiceAnswers,
  renderChoiceQuestionsText,
  validateChoiceAnswers,
} from "./choice-questions.ts";
import type { PendingAskTable } from "./pending-asks.ts";
import { askPerson } from "./session-ask-link.ts";
import type { ApprovalRequest, SessionAskPort } from "./session-backend.ts";

export interface SessionAskPortDeps {
  readonly table: PendingAskTable;
  readonly emit: (body: SessionEventBody) => void;
  readonly turn: () => { readonly turnId: string; readonly signal: AbortSignal } | undefined;
}

const ALREADY_ABORTED = AbortSignal.abort();

/** Rejects only an answer that carries choice answers the questions do not accept. */
function choiceValidator(questions: readonly ChoiceQuestion[]) {
  return (reply: AnswerReply): string | undefined =>
    "text" in reply && reply.answers !== undefined ? validateChoiceAnswers(questions, reply.answers) : undefined;
}

function noTurn(): NaxError {
  return new NaxError("No turn is running; an approval needs a running turn", "AGENT_SESSION_TURN_FAILED", {
    stage: "agent-session",
    detail: "no-turn",
  });
}

export function createSessionAskPort(deps: SessionAskPortDeps): SessionAskPort {
  const askDeps = { table: deps.table, emit: deps.emit };
  const now = (): string => new Date(_agentSessionDeps.now()).toISOString();
  return {
    async requestApproval(req: ApprovalRequest) {
      const turn = deps.turn();
      if (turn === undefined) throw noTurn();
      const signal = req.signal === undefined ? turn.signal : AbortSignal.any([turn.signal, req.signal]);
      const { signal: _ignored, ...ask } = req;
      return askPerson(askDeps, ask, signal);
    },
    // Informational only. The requestId is emitted but never put in the pending
    // table, so session.answer() on it is not answerable, and expiresAt is the
    // emit time (the auto-decision is already resolved), not a real deadline.
    recordAutoDecision(req, decision) {
      if (deps.turn() === undefined) return;
      const requestId = _agentSessionDeps.randomUUID();
      deps.emit({
        type: "approval_requested",
        requestId,
        ...(req.callId !== undefined ? { callId: req.callId } : {}),
        tool: req.tool,
        summary: req.summary,
        reason: req.reason,
        // US-004: an auto-decision carries whatever the request carried. No
        // caller sets this today (an unsandboxed ask is never auto-decided),
        // so it rides along rather than being silently dropped.
        ...(req.unsandboxed !== undefined ? { unsandboxed: req.unsandboxed } : {}),
        expiresAt: now(),
        answerable: false,
      });
      deps.emit({ type: "approval_resolved", requestId, decision, decidedBy: "profile" });
    },
    async askQuestion(text, opts) {
      const turn = deps.turn();
      if (turn === undefined) return null;
      const signal = opts?.signal === undefined ? turn.signal : AbortSignal.any([turn.signal, opts.signal]);
      const { requestId, expiresAt, settled } = deps.table.issue("question", signal);
      deps.emit({ type: "question", requestId, text, expiresAt });
      const settlement = await settled;
      return settlement.by === "human" && "text" in settlement.reply ? settlement.reply.text : null;
    },
    async askChoices(prompt, questions, opts) {
      const turn = deps.turn();
      if (turn === undefined) return null;
      const signal = opts?.signal === undefined ? turn.signal : AbortSignal.any([turn.signal, opts.signal]);
      const { requestId, expiresAt, settled } = deps.table.issue("question", signal, choiceValidator(questions));
      deps.emit({
        type: "question",
        requestId,
        text: renderChoiceQuestionsText(prompt, questions),
        expiresAt,
        questions,
        prompt,
      });
      const settlement = await settled;
      if (settlement.by !== "human" || !("text" in settlement.reply)) return null;
      const { text, answers } = settlement.reply;
      return answers === undefined ? { text } : { text: formatChoiceAnswers(questions, answers), answers };
    },
    noteQuestion(text) {
      if (deps.turn() === undefined) return;
      const { requestId } = deps.table.issue("question", ALREADY_ABORTED);
      deps.emit({ type: "question", requestId, text, expiresAt: now(), answerable: false });
    },
  };
}
