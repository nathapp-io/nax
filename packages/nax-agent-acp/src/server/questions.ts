/**
 * Questions (S5 spec §4.3). With form elicitation: one required free-text field,
 * the accepted text is the answer, anything else is the declined text. Without
 * it: the question is shown and answered at once with the no-answer text, so a
 * headless client never leaves the agent waiting. The open elicitation is aborted
 * at the question's expiresAt (M-14). An unanswerable question (M-1) is shown
 * only.
 */
import type { CreateElicitationResponse, SessionUpdate } from "@agentclientprotocol/sdk";
import type { AgentLogger, SessionEvent } from "@nathapp/nax-agent";
import { type ClientPort, type ElicitationForm, untilAborted } from "#src/server/client-port";
import { messageOf } from "#src/server/errors";
import type { Answer } from "#src/server/permissions";
import { announce } from "#src/server/translate/notice";

export const ANSWER_FIELD = "answer";
export const DECLINED_TEXT = "The user declined to answer.";
export const NO_ANSWER_TEXT =
  "No answer available: this client cannot answer questions. Proceed with your best judgement.";

export type QuestionEvent = Extract<SessionEvent, { type: "question" }>;

export interface QuestionBroker {
  /** Starts handling one question; never blocks the caller. */
  ask(event: QuestionEvent): void;
  abortAll(): void;
  drain(): Promise<void>;
}

export interface QuestionBrokerDeps {
  readonly port: ClientPort;
  /** The session's delivery (it handles a broken connection). */
  readonly deliver: (update: SessionUpdate) => Promise<void>;
  readonly answer: Answer;
  readonly logger: AgentLogger;
  readonly now?: () => number;
}

function formFor(text: string): ElicitationForm {
  return {
    message: text,
    requestedSchema: {
      type: "object",
      properties: { [ANSWER_FIELD]: { type: "string", title: "Answer" } },
      required: [ANSWER_FIELD],
    },
  };
}

function answerText(response: CreateElicitationResponse): string {
  if (response.action !== "accept") return DECLINED_TEXT;
  // The response union has an open `action: string` member, so read content defensively.
  const content: unknown = "content" in response ? response.content : undefined;
  const value = typeof content === "object" && content !== null ? Reflect.get(content, ANSWER_FIELD) : undefined;
  return typeof value === "string" && value.trim() !== "" ? value : DECLINED_TEXT;
}

export function createQuestionBroker(deps: QuestionBrokerDeps): QuestionBroker {
  const now = deps.now ?? Date.now;
  const open = new Set<AbortController>();
  const running = new Set<Promise<void>>();
  const notices = deps.port.features.updates.notices;

  async function elicit(event: QuestionEvent): Promise<void> {
    const controller = new AbortController();
    open.add(controller);
    const expiry = setTimeout(() => controller.abort(), Math.max(0, Date.parse(event.expiresAt) - now()));
    let text: string;
    try {
      text = answerText(
        await untilAborted(deps.port.elicit(formFor(event.text), controller.signal), controller.signal),
      );
    } catch (error) {
      if (controller.signal.aborted) return;
      deps.logger.warn("questions", "elicitation failed; answering without the user", { error: messageOf(error) });
      text = NO_ANSWER_TEXT;
    } finally {
      clearTimeout(expiry);
      open.delete(controller);
    }
    deps.answer(event.requestId, { text });
  }

  async function handle(event: QuestionEvent): Promise<void> {
    if (event.answerable === false) {
      await deps.deliver(announce(notices, "info", "The agent noted a question", event.text));
      return;
    }
    if (deps.port.features.elicitation) {
      await elicit(event);
      return;
    }
    await deps.deliver(announce(notices, "warning", "The agent asked a question", event.text));
    deps.answer(event.requestId, { text: NO_ANSWER_TEXT });
  }

  return {
    ask(event) {
      const work = handle(event);
      running.add(work);
      void work.finally(() => running.delete(work));
    },
    abortAll() {
      for (const controller of open) controller.abort();
    },
    async drain() {
      await Promise.all([...running]);
    },
  };
}
