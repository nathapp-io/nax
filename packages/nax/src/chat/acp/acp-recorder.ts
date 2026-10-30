/**
 * The ACP chat session wrapper.
 *
 * `recordAcpTurns` wraps an ACP `AgentSession` so a chat that switched onto an
 * ACP agent can hand that agent the conversation it has not seen. It forwards
 * every member of the wrapped session and puts a pending handoff in front of
 * the first message that reaches the agent.
 *
 * The handoff stays pending until a send ends with `turn_end` having shown
 * agent work (a non-empty text or thinking delta, or a tool call). This is
 * deliberately narrower than the evidence the ACP backend uses to mark its own
 * instructions delivered: a turn that failed before the agent saw the prompt
 * (an auth or quota failure) must not consume the handoff.
 */
import type {
  AgentSession,
  AnswerReply,
  AnswerStatus,
  CommandRunResult,
  SessionEvent,
  TranscriptStore,
} from "@nathapp/nax-agent";
import type { ChatAcpModel } from "./acp-model";

export interface RecordAcpTurnsInput {
  /** The native chat transcript store (the one at the sessions dir), not the agent's. */
  readonly store: TranscriptStore;
  readonly sessionId: string;
  readonly acp: ChatAcpModel;
  /** Rendered handoff, put in front of the first message sent; empty or absent means none. */
  readonly handoff?: string;
}

const HANDOFF_SEPARATOR = "\n\n";

/** Whether the event shows the agent received the prompt and did something with it. */
function showsAgentWork(event: SessionEvent): boolean {
  switch (event.type) {
    case "text_delta":
    case "thinking_delta":
      return event.text !== "";
    case "tool_call":
      return true;
    default:
      return false;
  }
}

/**
 * Forward the wrapped iteration unchanged and in order. When it reaches
 * `turn_end` after agent work, `onWorked` runs. A throw from the wrapped
 * iteration propagates to the caller untouched.
 */
async function* forwarded(
  events: AsyncIterable<SessionEvent>,
  onWorked: () => void,
): AsyncGenerator<SessionEvent, void, undefined> {
  let worked = false;
  for await (const event of events) {
    if (event.type === "turn_end") {
      if (worked) onWorked();
    } else if (showsAgentWork(event)) {
      worked = true;
    }
    yield event;
  }
}

export function recordAcpTurns(session: AgentSession, input: RecordAcpTurnsInput): AgentSession {
  let pendingHandoff = input.handoff === undefined || input.handoff === "" ? undefined : input.handoff;

  return {
    get id(): string {
      return session.id;
    },
    get backend(): AgentSession["backend"] {
      return session.backend;
    },
    get lastTurn(): AgentSession["lastTurn"] {
      return session.lastTurn;
    },
    get runCommand(): AgentSession["runCommand"] {
      const run = session.runCommand;
      if (run === undefined) return undefined;
      return (command: string, onEvent: (event: SessionEvent) => void): Promise<CommandRunResult> =>
        run.call(session, command, onEvent);
    },
    send(message: string): AsyncIterable<SessionEvent> {
      const payload = pendingHandoff === undefined ? message : `${pendingHandoff}${HANDOFF_SEPARATOR}${message}`;
      // Called here, not inside the generator: the wrapped send claims its turn slot (and throws when busy) synchronously.
      const events = session.send(payload);
      return forwarded(events, () => {
        pendingHandoff = undefined;
      });
    },
    answer(requestId: string, reply: AnswerReply): AnswerStatus {
      return session.answer(requestId, reply);
    },
    cancel(reason?: string): void {
      session.cancel(reason);
    },
    close(): Promise<void> {
      return session.close();
    },
  };
}
