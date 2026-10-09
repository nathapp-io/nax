/**
 * A scripted AgentSession (S5-2 M-8): each send() runs the next script, which
 * yields event bodies and can wait for answer() or cancel(). Records answers,
 * cancels and close.
 */
import type { AgentSession, AnswerReply, SessionEvent, SessionEventBody } from "@nathapp/nax-agent";

export const FAR_EXPIRY = "2099-01-01T00:00:00.000Z";

export interface ScriptControl {
  readonly message: string;
  /** The reply given to answer(requestId), or "cancelled" if the turn is cancelled first. */
  reply(requestId: string): Promise<AnswerReply | "cancelled">;
  /** Resolves when the turn is cancelled (cancel() or close()). */
  readonly cancelled: Promise<void>;
}

export type Script = (control: ScriptControl) => AsyncGenerator<SessionEventBody, void, void>;

type TurnEnd = Extract<SessionEventBody, { type: "turn_end" }>;

export function turnEnd(status: TurnEnd["status"], extra: Partial<TurnEnd> = {}): TurnEnd {
  return {
    type: "turn_end",
    status,
    output: "",
    usage: { inputTokens: 10, outputTokens: 5 },
    costUsd: 0,
    ...extra,
  };
}

export interface FakeAgentSessionOptions {
  readonly closeFails?: boolean;
  readonly lastTurn?: AgentSession["lastTurn"];
}

export interface FakeAgentSession {
  readonly session: AgentSession;
  readonly messages: string[];
  readonly answers: { readonly requestId: string; readonly reply: AnswerReply }[];
  cancels(): number;
  closed(): boolean;
}

export function fakeAgentSession(
  id: string,
  scripts: readonly Script[],
  options: FakeAgentSessionOptions = {},
): FakeAgentSession {
  const messages: string[] = [];
  const answers: { requestId: string; reply: AnswerReply }[] = [];
  const waiting = new Map<string, (reply: AnswerReply | "cancelled") => void>();
  const early = new Map<string, AnswerReply>();
  let cancelCount = 0;
  let isClosed = false;
  let turns = 0;
  let cancelTurn: () => void = () => {};

  async function* run(message: string): AsyncGenerator<SessionEvent> {
    turns += 1;
    const turnId = `t${turns}`;
    const base = { sessionId: id, turnId, at: "2026-10-09T00:00:00.000Z", metadata: {} };
    const script = scripts[turns - 1];
    if (script === undefined) {
      yield { ...base, ...turnEnd("errored", { error: { code: "FAKE_NO_SCRIPT", message: "no script" } }) };
      return;
    }
    let markCancelled: () => void = () => {};
    const cancelled = new Promise<void>((resolve) => {
      markCancelled = resolve;
    });
    cancelTurn = () => {
      markCancelled();
      for (const [requestId, settle] of waiting) {
        waiting.delete(requestId);
        settle("cancelled");
      }
    };
    const control: ScriptControl = {
      message,
      cancelled,
      reply: (requestId) => {
        const known = early.get(requestId);
        if (known !== undefined) return Promise.resolve(known);
        return new Promise((resolve) => waiting.set(requestId, resolve));
      },
    };
    for await (const body of script(control)) yield { ...base, ...body };
    cancelTurn = () => {};
  }

  const session: AgentSession = {
    id,
    backend: { kind: "fake", capabilities: {} },
    lastTurn: options.lastTurn,
    send(message) {
      messages.push(message);
      return run(message);
    },
    answer(requestId, reply) {
      answers.push({ requestId, reply });
      const settle = waiting.get(requestId);
      if (settle === undefined) {
        early.set(requestId, reply);
      } else {
        waiting.delete(requestId);
        settle(reply);
      }
      return "accepted";
    },
    cancel() {
      cancelCount += 1;
      cancelTurn();
    },
    async close() {
      isClosed = true;
      cancelTurn();
      if (options.closeFails === true) throw new Error("close failed");
    },
  };
  return { session, messages, answers, cancels: () => cancelCount, closed: () => isClosed };
}
