/**
 * One ACP session over one S3 AgentSession (S5 spec §3.2, §4.3, §4.4). A prompt
 * is one send(): each event goes through the translator to the client, and
 * approvals and questions start client round trips without blocking the stream.
 * If the client stops accepting updates, the turn is cancelled and drained so
 * the S3 turn slot is freed. In memory only (S5-2); S5-3 adds metadata, locks
 * and close-and-resume.
 */
import { type ContentBlock, type PromptResponse, RequestError, type SessionUpdate } from "@agentclientprotocol/sdk";
import type { AgentLogger, AgentSession, SessionEvent } from "@nathapp/nax-agent";
import type { ClientPort } from "#src/server/client-port";
import { messageOf, turnInProgress } from "#src/server/errors";
import { createPermissionBroker, type Decision, type PermissionBroker } from "#src/server/permissions";
import { flattenPrompt } from "#src/server/prompt";
import { createQuestionBroker, type QuestionBroker } from "#src/server/questions";
import type { ReadOldText } from "#src/server/translate/diff";
import { createEventTranslator, type EventTranslator } from "#src/server/translate/events";
import { type PromptOutcome, promptOutcome } from "#src/server/translate/stop";

/** S3's default turn limit, passed explicitly so the timeout notice names it (M-15). */
export const TURN_TIMEOUT_SECONDS = 3600;

export interface ServerSessionDeps {
  readonly session: AgentSession;
  readonly port: ClientPort;
  readonly cwd: string;
  readonly contextWindow?: number;
  readonly readOldText: ReadOldText;
  readonly logger: AgentLogger;
  readonly turnTimeoutSeconds: number;
  readonly now?: () => number;
}

export interface ServerSession {
  readonly id: string;
  readonly running: boolean;
  /** Delivered as the first updates of the next turn (M-11). */
  queueNotice(update: SessionUpdate): void;
  prompt(blocks: readonly ContentBlock[]): Promise<PromptResponse>;
  cancel(): void;
  close(): Promise<void>;
}

/** The answer when a cancel arrived before the S3 turn started: nothing ran. */
const CANCELLED_BEFORE_SEND: PromptOutcome = {
  kind: "response",
  response: { stopReason: "cancelled", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
  notices: [],
};

interface Turn {
  readonly permissions: PermissionBroker;
  readonly questions: QuestionBroker;
}

function react(event: SessionEvent, turn: Turn, translator: EventTranslator): void {
  switch (event.type) {
    case "approval_requested":
      if (event.answerable !== false) {
        turn.permissions.request(event, event.callId === undefined ? undefined : translator.toolCallFor(event.callId));
      }
      return;
    case "approval_resolved":
      turn.permissions.settled(event.requestId);
      return;
    case "question":
      turn.questions.ask(event);
      return;
    default:
      return;
  }
}

interface Delivery {
  deliver(update: SessionUpdate): Promise<void>;
  /** The first send failure, if any. */
  failure(): unknown;
}

/** Sends updates in order; on the first failure, cancels the turn and drops the rest. */
function createDelivery(deps: ServerSessionDeps): Delivery {
  let broken: unknown;
  return {
    failure: () => broken,
    async deliver(update) {
      if (broken !== undefined) return;
      try {
        await deps.port.update(update);
      } catch (error) {
        broken = error;
        deps.logger.warn("session", "client stopped accepting updates; cancelling the turn", {
          sessionId: deps.session.id,
          error: messageOf(error),
        });
        deps.session.cancel("client connection failed");
      }
    },
  };
}

interface TurnContext {
  readonly deps: ServerSessionDeps;
  readonly translator: EventTranslator;
  readonly turn: Turn;
  readonly delivery: Delivery;
}

/** One event: its updates, its round trips, and at turn_end the prompt outcome. */
async function forwardEvent(event: SessionEvent, ctx: TurnContext): Promise<PromptOutcome | undefined> {
  for (const update of await ctx.translator.translate(event)) await ctx.delivery.deliver(update);
  react(event, ctx.turn, ctx.translator);
  if (event.type !== "turn_end") return undefined;
  const outcome = promptOutcome(event, ctx.deps.turnTimeoutSeconds, ctx.deps.port.features.updates.notices);
  if (outcome.kind === "response") for (const notice of outcome.notices) await ctx.delivery.deliver(notice);
  return outcome;
}

export function createServerSession(deps: ServerSessionDeps): ServerSession {
  const memory = new Map<string, Decision>();
  let queued: readonly SessionUpdate[] = [];
  let costUsd = 0;
  let running = false;
  /** A cancel before send() claimed the S3 turn, where AgentSession.cancel() is a no-op. */
  let cancelBeforeSend = false;
  let turn: Turn | undefined;

  function stopWaiting(): void {
    turn?.permissions.abortAll();
    turn?.questions.abortAll();
  }

  async function runTurn(message: string): Promise<PromptOutcome | undefined> {
    const delivery = createDelivery(deps);
    const answer = deps.session.answer.bind(deps.session);
    const translator = createEventTranslator({
      cwd: deps.cwd,
      ...(deps.contextWindow !== undefined ? { contextWindow: deps.contextWindow } : {}),
      readOldText: deps.readOldText,
      clientUpdates: deps.port.features.updates,
      priorCostUsd: costUsd,
    });
    const current: Turn = {
      permissions: createPermissionBroker({ port: deps.port, answer, memory, logger: deps.logger }),
      questions: createQuestionBroker({
        port: deps.port,
        deliver: delivery.deliver,
        answer,
        logger: deps.logger,
        ...(deps.now !== undefined ? { now: deps.now } : {}),
      }),
    };
    turn = current;
    const ctx: TurnContext = { deps, translator, turn: current, delivery };
    let outcome: PromptOutcome | undefined;
    try {
      const pending = queued;
      queued = [];
      for (const update of pending) await delivery.deliver(update);
      if (cancelBeforeSend) {
        outcome = CANCELLED_BEFORE_SEND;
      } else if (delivery.failure() === undefined) {
        for await (const event of deps.session.send(message)) outcome = (await forwardEvent(event, ctx)) ?? outcome;
      }
    } finally {
      current.permissions.abortAll();
      current.questions.abortAll();
      await Promise.all([current.permissions.drain(), current.questions.drain()]);
      costUsd = translator.costUsd();
      turn = undefined;
    }
    const broken = delivery.failure();
    if (broken !== undefined) {
      throw RequestError.internalError(undefined, `could not send a session update: ${messageOf(broken)}`);
    }
    return outcome;
  }

  return {
    id: deps.session.id,
    get running() {
      return running;
    },
    queueNotice(update) {
      queued = [...queued, update];
    },
    async prompt(blocks) {
      if (running) throw turnInProgress();
      const message = flattenPrompt(blocks);
      running = true;
      cancelBeforeSend = false;
      let outcome: PromptOutcome | undefined;
      try {
        outcome = await runTurn(message);
      } finally {
        running = false;
      }
      if (outcome === undefined) throw RequestError.internalError(undefined, "the turn ended without a turn_end event");
      if (outcome.kind === "error") throw outcome.error;
      return outcome.response;
    },
    cancel() {
      if (running) cancelBeforeSend = true;
      deps.session.cancel("cancelled by the client");
      stopWaiting();
    },
    async close() {
      stopWaiting();
      await deps.session.close();
    },
  };
}
