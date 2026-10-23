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
  readonly priorCostUsd?: number;
  /** After each turn: title, timestamp and cumulative cost. A rejection is logged, never thrown. */
  readonly onTurnEnd?: (message: string, costUsd: number) => Promise<void>;
  /** S5-5 (wired in S5-5b Task 10): a display title for an MCP tool call's model name. */
  readonly titleFor?: (name: string) => string | undefined;
}

/** The S3 session and context window to adopt on a switchTo (spec §3.3). */
export interface SwitchTarget {
  readonly session: AgentSession;
  readonly contextWindow?: number;
}

export interface ServerSession {
  readonly id: string;
  readonly running: boolean;
  /** Delivered as the first updates of the next turn (M-11). */
  queueNotice(update: SessionUpdate): void;
  prompt(blocks: readonly ContentBlock[]): Promise<PromptResponse>;
  /** Close-and-reopen for a mode or config change (spec §3.3); `restore` reopens the old settings when `open` fails. */
  switchTo(open: () => Promise<SwitchTarget>, restore: () => Promise<SwitchTarget>): Promise<void>;
  isClosed(): boolean;
  /** A terminal close() was requested, whether or not it has finished (spec §Design 1). */
  isClosing(): boolean;
  cancel(): void;
  close(): Promise<void>;
}

/** The answer when a cancel arrived before the S3 turn started: nothing ran. */
const CANCELLED_BEFORE_SEND: PromptOutcome = {
  kind: "response",
  response: { stopReason: "cancelled", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
  notices: [],
};

const SESSION_CLOSED = "session is closed";

function sessionClosed(): RequestError {
  return RequestError.invalidRequest(undefined, SESSION_CLOSED);
}

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
function createDelivery(deps: ServerSessionDeps, agentOf: () => AgentSession): Delivery {
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
        agentOf().cancel("client connection failed");
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
  let costUsd = deps.priorCostUsd ?? 0;
  let closed = false;
  /** The closing flag: set by the first close(), so isClosing() is true from then on. */
  let closeRequested = false;
  /** The in-flight switchTo, while its gap runs (§Design 2). */
  let switching: Promise<void> | undefined;
  /** Whether the current agent is a live S3 session: false from the moment a switch closes it. */
  let live = true;
  let running = false;
  /** A cancel before send() claimed the S3 turn, where AgentSession.cancel() is a no-op. */
  let cancelBeforeSend = false;
  let turn: Turn | undefined;
  let agent: AgentSession = deps.session;
  let contextWindow = deps.contextWindow;
  let drained = Promise.resolve();
  let closing: Promise<void> | undefined;

  function stopWaiting(): void {
    turn?.permissions.abortAll();
    turn?.questions.abortAll();
  }

  async function reportTurnEnd(message: string): Promise<void> {
    if (deps.onTurnEnd === undefined) return;
    try {
      await deps.onTurnEnd(message, costUsd);
    } catch (error) {
      deps.logger.warn("session", "turn bookkeeping failed", { sessionId: deps.session.id, error: messageOf(error) });
    }
  }

  async function runTurn(message: string): Promise<PromptOutcome | undefined> {
    const delivery = createDelivery(deps, () => agent);
    const answer = agent.answer.bind(agent);
    const translator = createEventTranslator({
      cwd: deps.cwd,
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      readOldText: deps.readOldText,
      clientUpdates: deps.port.features.updates,
      priorCostUsd: costUsd,
      ...(deps.titleFor !== undefined ? { titleFor: deps.titleFor } : {}),
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
        for await (const event of agent.send(message)) outcome = (await forwardEvent(event, ctx)) ?? outcome;
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

  /** Adopts the session a switch's `open` or `restore` returned, and marks it live. */
  function adopt(target: SwitchTarget): void {
    agent = target.session;
    contextWindow = target.contextWindow;
    live = true;
  }

  /**
   * What `open` or `restore` left (§Design 3): the replacement, the restored
   * session plus the open error it must still surface, or nothing at all. A
   * discriminated outcome, so an open that rejects with `undefined` is never
   * mistaken for a failure-free switch.
   */
  type SwitchOutcome =
    | { readonly kind: "opened"; readonly target: SwitchTarget }
    | { readonly kind: "restored"; readonly target: SwitchTarget; readonly failure: unknown }
    | { readonly kind: "failed"; readonly failure: unknown };

  /** `open`, else `restore`; the open error survives even a successful restore. */
  async function openOrRestore(
    open: () => Promise<SwitchTarget>,
    restore: () => Promise<SwitchTarget>,
  ): Promise<SwitchOutcome> {
    try {
      return { kind: "opened", target: await open() };
    } catch (failure) {
      try {
        return { kind: "restored", target: await restore(), failure };
      } catch (restoreError) {
        deps.logger.error("session", "could not reopen the session after a failed switch", {
          sessionId: deps.session.id,
          error: messageOf(restoreError),
        });
        return { kind: "failed", failure };
      }
    }
  }

  /**
   * One switchTo (§3.3, §Design 2-3): close the old S3 session, then adopt what
   * `open` or `restore` left. A close requested meanwhile keeps the session
   * closed and turns the outcome into `session is closed`, after the adoption so
   * close() still knows what to close. Any failed open rejects, whatever its
   * reason, including an `undefined` one.
   */
  async function switchSession(open: () => Promise<SwitchTarget>, restore: () => Promise<SwitchTarget>): Promise<void> {
    stopWaiting();
    closed = true;
    live = false;
    try {
      await agent.close();
    } catch (error) {
      deps.logger.warn("session", "session close failed during switch", {
        sessionId: deps.session.id,
        error: messageOf(error),
      });
    }
    const outcome = await openOrRestore(open, restore);
    // Nothing was adopted: the session stays dead for the registry's cleanup.
    if (outcome.kind === "failed") {
      if (closeRequested) throw sessionClosed();
      throw outcome.failure;
    }
    adopt(outcome.target);
    if (closeRequested) throw sessionClosed();
    closed = false;
    if (outcome.kind === "restored") throw outcome.failure;
  }

  return {
    id: deps.session.id,
    isClosed: () => closed,
    isClosing: () => closeRequested,
    get running() {
      return running;
    },
    queueNotice(update) {
      queued = [...queued, update];
    },
    async prompt(blocks) {
      if (running) throw turnInProgress();
      if (closed) throw sessionClosed();
      const message = flattenPrompt(blocks);
      running = true;
      cancelBeforeSend = false;
      let finish: () => void = () => {};
      drained = new Promise<void>((resolve) => {
        finish = resolve;
      });
      let outcome: PromptOutcome | undefined;
      try {
        outcome = await runTurn(message);
      } finally {
        // Still "running" while the turn is recorded, so a switchTo cannot
        // slip in and write metadata from before this turn's title/updatedAt.
        try {
          await reportTurnEnd(message);
        } finally {
          running = false;
          finish();
        }
      }
      if (outcome === undefined) throw RequestError.internalError(undefined, "the turn ended without a turn_end event");
      if (outcome.kind === "error") throw outcome.error;
      return outcome.response;
    },
    async switchTo(open, restore) {
      if (closed) throw sessionClosed();
      if (running) throw turnInProgress();
      running = true;
      const work = switchSession(open, restore);
      switching = work;
      try {
        await work;
      } finally {
        // Cleared before this promise settles, whatever the outcome (§Design 2).
        switching = undefined;
        running = false;
      }
    },
    cancel() {
      if (running) cancelBeforeSend = true;
      agent.cancel("cancelled by the client");
      stopWaiting();
    },
    close() {
      if (closing !== undefined) return closing;
      closeRequested = true;
      // A switch whose open and restore both failed leaves a dead session that
      // the registry's dead-entry cleanup closes: nothing here to close.
      if (closed && switching === undefined) {
        closing = Promise.resolve();
        return closing;
      }
      const inFlight = switching;
      closed = true; // Refuse new prompts/switches before the first await.
      cancelBeforeSend = true;
      agent.cancel("session is closing");
      stopWaiting();
      closing = (async () => {
        // The switch owns `agent` until it settles; then close only what it
        // left live, so a switch that left nothing is not closed twice.
        if (inFlight !== undefined) await inFlight.catch(() => undefined);
        try {
          if (live) await agent.close();
        } finally {
          // AgentSession.close need not await the facade's event delivery or
          // onTurnEnd. Ownership must outlive both, even if close rejects.
          await drained;
        }
      })();
      return closing;
    },
  };
}
