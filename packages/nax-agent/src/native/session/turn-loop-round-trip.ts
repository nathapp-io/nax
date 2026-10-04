/**
 * The round-trip loop and turn-end phase of the native turn loop.
 *
 * Split out of `./turn-loop.ts` during the complexity drain
 * (docs/plans/STATUS-complexity-drain.md A2): `runNativeTurn` scored 97 as one
 * function covering setup, the round-trip loop (deliberately unbounded —
 * bounded by the deadline, the idle watchdog, and the spin breaker, not a
 * call count), and the `before_turn_end` continuation decision. Both loop
 * bodies move here unchanged; only the plumbing that threads state across
 * calls changed shape. A pure extraction: no loop rule changed.
 *
 * `runRoundTripLoop` mutates its `state` argument in place rather than
 * returning a new one, and does so on every field the moment each value is
 * known — not only at a clean exit. The original was one function where
 * `messages` (and friends) were plain `let`s: a mid-loop throw (the
 * `batch.cancelled` path below) still left the catch block reading the
 * latest values, because it was the same variable. Returning a fresh object
 * only at the end of the function would lose every update since the last
 * return the moment a throw skips it — exactly the synthetic tool-result
 * messages `runToolBatch` just appended before signalling cancellation. The
 * caller passes one `TurnLoopState` and keeps reading through that same
 * reference after an `await` that might throw.
 *
 * `spinStopped` / `spinWarned` were two `let`s in `runNativeTurn`, one of them
 * (`spinWarned`) mutated by an `onSpinStop` closure registered ONCE in setup,
 * before either extracted function is ever called, and read/written across
 * every outer-loop iteration after that. Splitting the loop body out cannot
 * split that closure's target too, so both flags now live in one mutable
 * `SpinFlags` object created in setup and threaded by reference into every
 * call here — the same shared-mutable-state semantics as the original two
 * `let`s, just addressed through an object instead of two closed-over
 * bindings.
 */

import type { ToolCall, ToolDefinition } from "@nathapp/nax-ai";
import { inputClassTokens } from "#src/cost/core/index";
import { getSafeLogger } from "#src/infra/index";
import type { SpinBreaker } from "#src/infra/spin-breaker/index";
import type { InteractionExchange, SendTurnOpts, SessionHandle } from "#src/session/session-types";
import {
  estimateContextTokens,
  type TranscriptMessage as NativeTranscriptMessage,
  shouldCompact,
} from "./compaction.ts";
import type { InvalidCallBudget } from "./handle-invalid-tool-call.ts";
import type { LoopEventRegistry } from "./loop-events/index.ts";
import type { createTurnAccumulator } from "./turn-accumulator.ts";
import { usageBeat } from "./turn-accumulator.ts";
import { runProactiveCompaction } from "./turn-compaction-step.ts";
import { completeWithRecovery } from "./turn-complete-step.ts";
import { type TurnEventEmitter, usageEvent } from "./turn-event-emitter.ts";
import { runToolBatch } from "./turn-tool-batch.ts";
import type { TurnDeps } from "./turn-types.ts";

/**
 * The per-turn bound on `before_turn_end`'s followUp channel (spec 6.4): the
 * only event that can spend money on its own, so injections are capped per
 * turn regardless of what handlers return. At the cap the channel stops and
 * the turn ends.
 */
export const MAX_FOLLOW_UPS_PER_TURN = 3;

/** Shared across every call in one turn — see the file header. */
export interface SpinFlags {
  /** Set ONLY when the breaker ended the turn, so the wiring layer can classify it as `fail-spin` rather than a generic incomplete turn. */
  stopped: boolean;
  /** nax#2120: the first stop verdict spends a terminal round trip rather than tearing the turn down, so a false positive does not cost the transcript. */
  warned: boolean;
}

/** Values that change across outer-loop (followUp) iterations. */
export interface TurnLoopState {
  messages: NativeTranscriptMessage[];
  lastUsage: { promptTokens: number } | undefined;
  anchorIndex: number | undefined;
  roundTrips: number;
  output: string;
  completedNormally: boolean;
  timedOut: boolean;
  followUpsSoFar: number;
}

/** Turn-scoped values that never change across outer-loop iterations. */
export interface TurnRoundParams {
  handle: SessionHandle;
  opts: SendTurnOpts;
  deps: TurnDeps;
  /** `transcriptIdentity.model` — carried into every `sessionState.lastUsage.set` this turn writes. */
  transcriptModel: string | undefined;
  tools: ToolDefinition[];
  codingToolNames: ReadonlySet<string>;
  loopEvents: LoopEventRegistry;
  invalidCallBudget: InvalidCallBudget;
  spinBreaker: SpinBreaker | undefined;
  spinFlags: SpinFlags;
  maxInteractions: number;
  /** Mutated in place — the caller owns the turn-lifetime array. */
  interactions: InteractionExchange[];
  /** Mutated in place — the caller owns the turn-lifetime array. */
  codingToolsCalled: string[];
  /** Mutated in place via `.add()` — the caller owns the turn-lifetime accumulator. */
  usage: ReturnType<typeof createTurnAccumulator>;
  /** S3-3: the turn's one event emitter (a no-op without an `onTurnEvent` sink). */
  turnEvents: TurnEventEmitter;
}

/**
 * Compaction runs at most once per round trip. That bound is what stops a
 * compact-still-over-compact loop when the pinned prompt alone is too large.
 * The returned `summarizeFailed` is read by the overflow-retry backstop
 * (`canRetry = ... && !summarizeFailed && ...`) inside `completeWithRecovery`,
 * which suppresses a doomed retry after the summarizer has already failed
 * this round trip.
 */
async function maybeCompact(state: TurnLoopState, params: TurnRoundParams): Promise<{ summarizeFailed: boolean }> {
  const { handle, opts, deps, loopEvents } = params;
  // Guard clauses, not one big `&&`: each keeps TS's narrowing of deps.summarize
  // / contextWindow / compaction live for the `deps: {...}` literal below,
  // which a hoisted boolean would have thrown away.
  if (deps.summarize === undefined || deps.contextWindow === undefined || deps.compaction === undefined) {
    return { summarizeFailed: false };
  }
  if (
    !shouldCompact(
      estimateContextTokens(state.messages, state.lastUsage, state.anchorIndex),
      deps.contextWindow,
      deps.compaction,
    )
  ) {
    return { summarizeFailed: false };
  }

  const step = await runProactiveCompaction({
    messages: state.messages,
    usage: params.usage,
    sessionName: handle.id,
    lastUsage: state.lastUsage,
    anchorIndex: state.anchorIndex,
    // The loop's local, not deps.loopEvents — the same registry
    // completeWithRecovery and runToolBatch receive below, so every
    // dispatch seam observes the same handlers.
    loopEvents,
    // Copied, not the `deps` object itself: the guards above narrow the
    // three properties to defined, and a fresh object is what carries that
    // narrowing into the step's `CompactionStepDeps` parameter.
    deps: {
      summarize: deps.summarize,
      contextWindow: deps.contextWindow,
      compaction: deps.compaction,
      onActivity: deps.onActivity,
      deadline: deps.deadline,
    },
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  });
  state.messages = [...step.messages];
  if (step.compacted) {
    // The anchor described the pre-compaction array; it is meaningless now.
    state.lastUsage = undefined;
    state.anchorIndex = undefined;
    params.turnEvents.emit({ type: "compaction", reason: "proactive" });
  }
  return { summarizeFailed: step.summarizeFailed };
}

/**
 * One model call and its bookkeeping: `completeWithRecovery`, the usage/anchor
 * updates, the activity beats, `after_response`, and pushing the settled
 * assistant message. Returns the tool calls the model asked for, if any —
 * `undefined` means the turn completed normally (mutates
 * `state.completedNormally`).
 */
async function runModelRoundTrip(
  state: TurnLoopState,
  params: TurnRoundParams,
  summarizeFailed: boolean,
): Promise<readonly ToolCall[] | undefined> {
  const { handle, opts, deps, tools, loopEvents } = params;
  const step = await completeWithRecovery({
    messages: state.messages,
    tools,
    usage: params.usage,
    summarizeFailed,
    sessionName: handle.id,
    lastUsage: state.lastUsage,
    anchorIndex: state.anchorIndex,
    // The loop's local, not deps.loopEvents — the same registry runToolBatch
    // below receives, so both dispatch seams observe the same handlers.
    loopEvents,
    // 1-based, matching the usage beat below: the request being issued is
    // round trip roundTrips + 1 — before_request(0-based N) and a later
    // after_response(1-based N) would otherwise disagree on the same trip.
    roundTrip: state.roundTrips + 1,
    ...(handle.modelDef?.model !== undefined ? { model: handle.modelDef.model } : {}),
    deps,
    turnEvents: params.turnEvents,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  });
  const res = step.res;
  state.messages = [...step.messages];
  // The anchor described the pre-compaction array (compacted), or a
  // prefix the provider was never sent (a boundary-exempt transform_context
  // rewrite — spec 3.6: the wire changed even though the saved array did
  // not); it is meaningless now. Compaction invalidates it unconditionally;
  // a transform_context honour clears only when it rode the boundary
  // exemption — a prefix-stable honour leaves the anchor valid (spec 6.6:
  // wire and persisted prefix are reference-identical, nothing to invalidate).
  if (step.compacted || (step.honoured && step.boundary)) {
    state.lastUsage = undefined;
    state.anchorIndex = undefined;
  }
  state.roundTrips += 1;
  params.usage.add(res.usage, res.costUsd, res.rates);
  state.output = res.text;

  // nax#1852: the anchor is the whole prompt the provider charged for, not
  // just its uncached portion. Under prompt caching (which the round trip
  // above always requests) the cached prefix arrives in the cache fields,
  // and counting inputTokens alone reads a 71k-token context as ~16.
  const promptTokens = inputClassTokens(res.usage);
  state.lastUsage = { promptTokens };
  state.anchorIndex = state.messages.length - 1;
  deps.sessionState.lastUsage.set(handle.id, {
    promptTokens,
    anchorIndex: state.anchorIndex,
    ...(params.transcriptModel !== undefined ? { model: params.transcriptModel } : {}),
  });

  // 1-based; `roundTrips` is incremented above, before this beat fires.
  deps.onActivity?.(usageBeat(res.usage, res.costUsd, state.roundTrips));
  params.turnEvents.emit(usageEvent(state.roundTrips, res.usage, res.costUsd));
  if (res.text.length > 0) deps.onActivity?.({ kind: "message", bytes: res.text.length });
  if (res.thinking !== undefined && res.thinking.length > 0) {
    deps.onActivity?.({
      kind: "thinking",
      bytes: res.thinking.reduce((n, t) => n + t.text.length, 0),
    });
  }

  // P3 `after_response` (spec 6.1): fires once per round trip on the
  // settled assistant message, BEFORE it enters the array — a patch is
  // safe by construction because it shapes the message, never the array,
  // so the anchorIndex recorded above (`messages.length - 1`, which runs
  // before this push) keeps describing the prefix the provider charged
  // for. `usage`/`costUsd` are surfaced readonly: the registry reads only
  // the patchable fields off a return, so billing truth cannot surface
  // even from a handler that bypasses the type.
  const afterResponse = await loopEvents.dispatch("after_response", {
    text: res.text,
    ...(res.toolCalls !== undefined ? { toolCalls: res.toolCalls } : {}),
    ...(res.thinking !== undefined ? { thinking: res.thinking } : {}),
    usage: res.usage,
    costUsd: res.costUsd,
    roundTrip: state.roundTrips,
  });
  // The pushed message carries the patched shape, and the loop acts on
  // what it records: answering the ORIGINAL calls while recording patched
  // ones would desync the transcript from what actually executed.
  const assistantText = afterResponse.text ?? res.text;
  const assistantToolCalls: readonly ToolCall[] | undefined = afterResponse.toolCalls ?? res.toolCalls;
  const assistantThinking = afterResponse.thinking ?? res.thinking;

  // Thinking blocks are appended, not merely representable: Anthropic needs
  // the exact block back to continue a thinking conversation (ADR-028 s8).
  state.messages.push({
    role: "assistant",
    content: assistantText,
    ...(assistantToolCalls !== undefined ? { toolCalls: assistantToolCalls } : {}),
    ...(assistantThinking !== undefined ? { thinking: assistantThinking } : {}),
  });

  if (assistantToolCalls === undefined || assistantToolCalls.length === 0) {
    state.completedNormally = true;
    return undefined;
  }
  return assistantToolCalls;
}

/**
 * Answers the round trip's tool calls and decides whether the round-trip loop
 * should keep going. `state` is already up to date (mutated above, not
 * returned — see the file header) the moment `batch.cancelled` throws, so the
 * caller's catch block still sees this batch's messages.
 */
async function dispatchToolBatch(
  state: TurnLoopState,
  params: TurnRoundParams,
  toolCalls: readonly ToolCall[],
): Promise<{ shouldBreak: boolean }> {
  const { opts, deps, tools, codingToolNames, loopEvents, invalidCallBudget, spinBreaker, spinFlags, maxInteractions } =
    params;
  const batch = await runToolBatch({
    messages: state.messages,
    toolCalls,
    tools,
    codingToolNames,
    roundTrips: state.roundTrips,
    opts,
    deps,
    loopEvents,
    invalidCallBudget,
    spinBreaker,
    maxInteractions,
    spinWarned: spinFlags.warned,
    interactionsSoFar: params.interactions.length,
  });
  state.messages = [...batch.messages];
  params.interactions.push(...batch.interactions);
  params.codingToolsCalled.push(...batch.codingToolsCalled);
  if (batch.spinStopped) spinFlags.stopped = true;
  if (batch.spinStopped || batch.budgetExceeded) return { shouldBreak: true };
  // US-002: a cancelled turn signal during the batch answers every
  // outstanding call synthetically and stops the loop. The throw routes
  // through the existing catch block — its best-effort transcript save
  // persists the synthetic results before the throw propagates, keeping one
  // result per assistant id in the saved transcript (AC2 / AC3). AC4 carries
  // the abort reason verbatim; AC6 — a no-reason abort — produces a
  // DOMException named AbortError, the contract `build-hop-callback` and the
  // idle-watchdog key on.
  if (batch.cancelled) {
    throw deps.signal?.reason ?? new DOMException("signal is aborted without reason", "AbortError");
  }
  return { shouldBreak: false };
}

/**
 * Deliberately unbounded by COUNT of varied calls. A coding agent working a
 * story is bounded by wall clock (deps.deadline), by the idle watchdog, and
 * — since nax#2013 — by the spin breaker, which ends a turn that keeps
 * REPEATING a call it already made. `agent.maxInteractionTurns` is NOT this
 * budget — it bounds human Q&A exchanges, which are counted separately.
 */
export async function runRoundTripLoop(state: TurnLoopState, params: TurnRoundParams): Promise<void> {
  while (true) {
    // Checked before starting a round-trip rather than after finishing one:
    // starting a call we know cannot finish inside the budget spends money for
    // an answer we will discard.
    if (params.deps.deadline?.expired() === true) {
      state.timedOut = true;
      break;
    }

    const { summarizeFailed } = await maybeCompact(state, params);
    const toolCalls = await runModelRoundTrip(state, params, summarizeFailed);
    if (toolCalls === undefined) break; // completedNormally already set

    const { shouldBreak } = await dispatchToolBatch(state, params, toolCalls);
    if (shouldBreak) break;
  }
}

export type TurnEndOutcome = { action: "break" } | { action: "continue"; state: TurnLoopState };

/**
 * P3 `before_turn_end` (spec 6.4): fires at every turn ENDING, before the
 * final turn-end transcript save. `stopped` is dispatcher-computed: the three endings
 * that are stops, not completions — the spin breaker (nax#2120), the
 * invalid-call budget (nax#2047), and the deadline — close the followUp
 * channel entirely, because resurrecting a turn a breaker just killed would
 * re-open the loops those breakers exist to close. The payload's `stopped`
 * flag is all a handler sees: WHICH breaker fired is not leaked, and any
 * followUp returned against a stop is ignored (with a warn — a handler
 * trying to resurrect is worth a trace). The channel is also capped per turn
 * at MAX_FOLLOW_UPS_PER_TURN.
 */
export async function runTurnEndPhase(state: TurnLoopState, params: TurnRoundParams): Promise<TurnEndOutcome> {
  const stopped = params.spinFlags.stopped || params.invalidCallBudget.exceeded || state.timedOut;
  const turnEnd = await params.loopEvents.dispatch("before_turn_end", {
    messages: state.messages,
    roundTrips: state.roundTrips,
    ended: "completed",
    stopped,
    followUpsSoFar: state.followUpsSoFar,
  });
  if (stopped || state.followUpsSoFar >= MAX_FOLLOW_UPS_PER_TURN) {
    if (turnEnd.followUp !== undefined) {
      getSafeLogger()?.warn("native-loop-events", "before_turn_end followUp ignored", {
        sessionName: params.handle.id,
        ...(stopped ? { reason: "stopped" } : { reason: "cap", cap: MAX_FOLLOW_UPS_PER_TURN }),
      });
    }
    return { action: "break" };
  }
  if (turnEnd.followUp === undefined) return { action: "break" };
  // Honoured: the user message enters the array and the outer loop
  // re-enters the round-trip loop — each injection counts as its own
  // round trip through the normal loop, and the turn's result is NOT
  // built here.
  const messages = [...state.messages, { role: "user" as const, content: turnEnd.followUp }];
  // The continuation must earn its own clean exit, and a reprieved stop's
  // terminal-round-trip snapshot does not carry into it — the breaker's
  // own cumulative, session-lifetime counters (nax#2047) still enforce.
  params.spinFlags.warned = false;
  return {
    action: "continue",
    state: {
      ...state,
      messages,
      followUpsSoFar: state.followUpsSoFar + 1,
      completedNormally: false,
    },
  };
}
