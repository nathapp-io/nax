/**
 * One turn of an agent session (spec 4.2, 4.4, 5.5, 6.1). claimTurn takes the
 * session's single-flight slot synchronously; the turn starts on the
 * consumer's first next(). Write order: markTurn(running), sendTurn (the loop
 * saves), markTurn(ended), then turn_end. The slot is released before
 * turn_end is emitted, so a consumer may send() again on seeing it. A turn
 * never throws to the consumer: every failure becomes turn_end.
 */
import type { TokenUsage } from "#src/cost/standard-types";
import { NaxError } from "#src/infra/nax-error";
import { redactSecrets } from "#src/internal/redact";
import type { LoopHandlerContext, LoopHandlerSet } from "#src/native/session/loop-events/types";
import type { TranscriptStore } from "#src/native/session/transcript-types";
import { readNativeTurnFailureUsage } from "#src/native/session/turn-types";
import type { CodingTool } from "#src/tools/registry";
import { _agentSessionDeps } from "./agent-session-deps.ts";
import { AgentSessionError } from "./agent-session-errors.ts";
import type { SessionEvent, SessionEventBody, TurnEndStatus } from "./agent-session-types.ts";
import type { InteractionHandler } from "./interaction-handler.ts";
import { createSessionEventChannel } from "./session-event-channel.ts";
import { type AgentSessionAdapter, type SessionHandle, SessionTurnError, type TurnResult } from "./session-types.ts";

/** The ask_human budget per turn: nax's agent.maxInteractionTurns default. */
export const ASK_HUMAN_BUDGET = 10;

/** Codes of the turn signal's abort reasons. AbortSignal keeps the first reason, so the first cause wins. */
const CANCELLED = "AGENT_SESSION_CANCELLED";
const TIMED_OUT = "AGENT_SESSION_TURN_TIMEOUT";
const STALLED = "AGENT_SESSION_CONSUMER_STALLED";

const ZERO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0 };

export interface TurnRunContext {
  readonly sessionId: string;
  readonly adapter: AgentSessionAdapter;
  readonly handle: SessionHandle;
  readonly store: TranscriptStore;
  readonly codingTools: readonly CodingTool[];
  readonly interactionHandler: InteractionHandler;
  readonly loopHandlers: LoopHandlerSet | undefined;
  readonly loopHandlerContext: LoopHandlerContext;
  readonly turnTimeoutSeconds: number;
  readonly metadata: Readonly<Record<string, string>>;
}

/** The running turn, as the ask link and the interaction handler see it. */
export interface LiveTurn {
  readonly turnId: string;
  readonly signal: AbortSignal;
  emit(body: SessionEventBody): void;
}

export interface ClaimedTurn {
  readonly turnId: string;
  readonly iterable: AsyncIterable<SessionEvent>;
  /** Resolves once the turn has ended, or at once for a claim voided before it started. */
  readonly settled: Promise<void>;
  cancel(reason: string): void;
}

export interface ClaimTurnHooks {
  readonly onStart: (live: LiveTurn) => void;
  /** Runs before turn_end is emitted. `status` is undefined for a voided claim. */
  readonly onSettle: (turnId: string, status: TurnEndStatus | undefined) => void;
}

type TurnEndBody = Extract<SessionEventBody, { readonly type: "turn_end" }>;
type TurnFailure = { readonly code: string; readonly message: string };

function abortReason(code: string, message: string): NaxError {
  return new NaxError(message, code, { stage: "agent-session" });
}

function abortCode(signal: AbortSignal): string | undefined {
  return signal.aborted && signal.reason instanceof NaxError ? signal.reason.code : undefined;
}

function failure(code: string, message: string): TurnFailure {
  return { code, message: redactSecrets(message) };
}

function haltOf(result: TurnResult): TurnFailure | undefined {
  if (result.spinStopped === true) {
    return failure("AGENT_SESSION_SPIN_STOPPED", "The turn was stopped: the agent repeated calls without progress.");
  }
  if (result.invalidCallBudgetExceeded === true) {
    const call = result.invalidToolCall;
    const detail =
      call === undefined ? "" : ` (${call.tool}.${call.property}: expected ${call.expected}, got ${call.actual})`;
    return failure(
      "AGENT_SESSION_INVALID_TOOL_CALLS",
      `The turn was stopped after repeated invalid tool calls${detail}.`,
    );
  }
  if (result.turnIncomplete === true) {
    return failure("AGENT_SESSION_TURN_INCOMPLETE", "The turn ended with tool calls still pending.");
  }
  return undefined;
}

/** Maps a returned TurnResult to turn_end. Exported for its unit test. */
export function turnEndFromResult(result: TurnResult): TurnEndBody {
  const base = {
    type: "turn_end" as const,
    output: result.output,
    usage: result.tokenUsage,
    costUsd: result.exactCostUsd ?? result.estimatedCostUsd,
  };
  if (result.timedOut === true) return { ...base, status: "timed_out" };
  const halt = haltOf(result);
  return halt === undefined ? { ...base, status: "completed" } : { ...base, status: "errored", error: halt };
}

function errorOf(err: unknown): TurnFailure {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof SessionTurnError && err.adapterFailure !== undefined)
    return failure(err.adapterFailure.outcome, message);
  if (err instanceof NaxError) return failure(err.code, message);
  return failure("AGENT_SESSION_TURN_FAILED", message);
}

function spendOf(err: unknown): { readonly usage: TokenUsage; readonly costUsd: number } {
  const recorded = readNativeTurnFailureUsage(err);
  if (recorded !== undefined) return { usage: recorded.tokenUsage, costUsd: recorded.costUsd };
  if (err instanceof SessionTurnError)
    return { usage: err.tokenUsage ?? ZERO_USAGE, costUsd: err.estimatedCostUsd ?? 0 };
  return { usage: ZERO_USAGE, costUsd: 0 };
}

function fromError(err: unknown, signal: AbortSignal): TurnEndBody {
  const base = { type: "turn_end" as const, output: "", ...spendOf(err) };
  const code = abortCode(signal);
  if (code === STALLED) {
    const message = `More than ${_agentSessionDeps.controlEventCap} control events went undelivered; the turn was cancelled.`;
    return { ...base, status: "errored", error: failure(STALLED, message) };
  }
  if (code === TIMED_OUT) return { ...base, status: "timed_out" };
  if (signal.aborted) return { ...base, status: "cancelled" };
  return { ...base, status: "errored", error: errorOf(err) };
}

function sendTurn(ctx: TurnRunContext, live: LiveTurn, message: string): Promise<TurnResult> {
  return ctx.adapter.sendTurn(ctx.handle, message, {
    interactionHandler: ctx.interactionHandler,
    codingTools: ctx.codingTools,
    maxInteractions: ASK_HUMAN_BUDGET,
    turnId: live.turnId,
    signal: live.signal,
    onTurnEvent: (event) => live.emit(event),
    loopHandlerContext: ctx.loopHandlerContext,
    ...(ctx.loopHandlers !== undefined ? { loopHandlers: ctx.loopHandlers } : {}),
  });
}

/** Writes the turn marker; a failure is returned, not thrown. */
async function markTurn(
  ctx: TurnRunContext,
  turnId: string,
  state: "running" | "ended",
): Promise<{ readonly error: unknown } | undefined> {
  try {
    await ctx.store.markTurn(ctx.sessionId, { turnId, state });
    return undefined;
  } catch (error) {
    return { error };
  }
}

async function runTurn(ctx: TurnRunContext, live: LiveTurn, message: string): Promise<TurnEndBody> {
  live.emit({ type: "turn_start" });
  const started = await markTurn(ctx, live.turnId, "running");
  if (started !== undefined) return fromError(started.error, live.signal);
  let end: TurnEndBody;
  try {
    end = turnEndFromResult(await sendTurn(ctx, live, message));
  } catch (err) {
    end = fromError(err, live.signal);
  }
  const ended = await markTurn(ctx, live.turnId, "ended");
  // A failed end marker fails the turn (spec 5.5) but keeps its output and spend.
  return ended === undefined ? end : { ...end, status: "errored", error: errorOf(ended.error) };
}

function singleUse(iterator: AsyncIterator<SessionEvent>, sessionId: string): AsyncIterable<SessionEvent> {
  let taken = false;
  return {
    [Symbol.asyncIterator]() {
      if (taken) {
        throw new AgentSessionError("send() returns a single-use iterable; iterate it once", "AGENT_SESSION_BUSY", {
          sessionId,
        });
      }
      taken = true;
      return iterator;
    },
  };
}

export function claimTurn(ctx: TurnRunContext, message: string, hooks: ClaimTurnHooks): ClaimedTurn {
  const turnId = _agentSessionDeps.randomUUID();
  const controller = new AbortController();
  let state: "claimed" | "running" | "settled" = "claimed";
  let resolveSettled: () => void = () => {};
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });

  const channel = createSessionEventChannel({
    controlCap: _agentSessionDeps.controlEventCap,
    onFirstPull: () => start(),
    onReturn: () => cancel("iterator closed"),
    onStall: () => controller.abort(abortReason(STALLED, "consumer stalled")),
  });
  const emit = (body: SessionEventBody): void => {
    const at = new Date(_agentSessionDeps.now()).toISOString();
    channel.push({ sessionId: ctx.sessionId, turnId, at, metadata: ctx.metadata, ...body });
  };
  const live: LiveTurn = { turnId, signal: controller.signal, emit };

  function settle(end: TurnEndBody | undefined): void {
    state = "settled";
    hooks.onSettle(turnId, end?.status);
    if (end !== undefined) emit(end);
    channel.end();
    resolveSettled();
  }

  function start(): void {
    if (state !== "claimed") return;
    state = "running";
    const timer = _agentSessionDeps.setTimeout(
      () => controller.abort(abortReason(TIMED_OUT, "turn deadline")),
      ctx.turnTimeoutSeconds * 1000,
    );
    hooks.onStart(live);
    void runTurn(ctx, live, message)
      .catch((err: unknown) => fromError(err, controller.signal))
      .then((end) => {
        _agentSessionDeps.clearTimeout(timer);
        settle(end);
      });
  }

  function cancel(reason: string): void {
    if (state === "claimed") settle(undefined);
    else if (state === "running") controller.abort(abortReason(CANCELLED, reason));
  }

  return { turnId, iterable: singleUse(channel.iterator, ctx.sessionId), settled, cancel };
}
