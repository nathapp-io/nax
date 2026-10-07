/**
 * ACP sendTurn phases — extracted from adapter.ts (complexity / file-size
 * split, see project conventions).
 *
 * The turn loop's mutable state lives in one `SendTurnState` object created
 * per sendTurn call and MUTATED IN PLACE by every phase below: the loop's
 * `continue`/`break` decisions read the same object the previous iteration
 * wrote, so no phase ever returns a fresh state to replace it. The frame
 * (`SendTurnFrame`) holds what is fixed for the whole call — the session
 * handle impl (whose `_session` pointer the NO_SESSION recovery swaps), the
 * interaction opts, the rate card, and the turn deadline.
 */

import { createTurnDeadline } from "@nathapp/nax-agent";
import { getSafeLogger } from "@/logger";
import type { ITokenUsageMapper, RateCard, TokenUsage } from "../cost";
import { addTokenUsage, estimateCostUsd } from "../cost";
import {
  awaitInteractionReply,
  type ContextToolCall,
  extractContextToolCall,
  extractQuestion,
  type InteractionReplyContext,
  toContextToolInteraction,
} from "../interaction";
import type { InteractionExchange, SendTurnOpts, TurnResult } from "../types";
import { SessionTurnError } from "../types";
import {
  type AcpSessionHandleImpl,
  ensureAcpSession,
  runSessionPrompt,
  warnWallClockTimeout,
} from "./adapter-lifecycle";
import { buildTurnResult, extractOutput } from "./adapter-output";
import type { AcpSessionResponse } from "./adapter-session-types";
import type { SessionTokenUsage } from "./wire-types";

const DEFAULT_MAX_INTERACTIONS = 10;

// ─────────────────────────────────────────────────────────────────────────────
// Frame + state
// ─────────────────────────────────────────────────────────────────────────────

/** Everything fixed for the duration of one sendTurn call. */
export interface SendTurnFrame {
  impl: AcpSessionHandleImpl;
  mapper: ITokenUsageMapper<SessionTokenUsage>;
  opts: SendTurnOpts;
  sessionName: string;
  timeoutSeconds: number;
  rateCard: RateCard;
  maxInteractions: number;
  turnDeadline: ReturnType<typeof createTurnDeadline>;
}

/** The turn loop's working state — mutated in place, never replaced. */
export interface SendTurnState {
  sessionRecreated: boolean;
  totalTokenUsage: TokenUsage;
  totalExactCostUsd: number | undefined;
  /** Mid-turn human Q&A exchanges captured for the prompt-audit trail (issue #1226). */
  interactions: InteractionExchange[];
  turnCount: number;
  lastResponse: AcpSessionResponse | null;
  timedOut: boolean;
  aborted: boolean;
  currentPrompt: string;
}

export function buildSendTurnFrame(input: {
  impl: AcpSessionHandleImpl;
  mapper: ITokenUsageMapper<SessionTokenUsage>;
  opts: SendTurnOpts;
}): SendTurnFrame {
  const { impl, mapper, opts } = input;
  const { _sessionName: sessionName, _timeoutSeconds: timeoutSeconds, _rateCard: rateCard } = impl;
  return {
    impl,
    mapper,
    opts,
    sessionName,
    timeoutSeconds,
    rateCard,
    // ACP spends the budget as this loop's bound, which is its intended use:
    // the sub-agent's own tool calling happens inside one session.prompt(),
    // so an iteration here is always a nax-side interaction. Native differs.
    maxInteractions: opts.maxInteractions ?? DEFAULT_MAX_INTERACTIONS,
    turnDeadline: createTurnDeadline(timeoutSeconds),
  };
}

export function initialSendTurnState(prompt: string): SendTurnState {
  return {
    sessionRecreated: false,
    totalTokenUsage: { inputTokens: 0, outputTokens: 0 },
    totalExactCostUsd: undefined,
    interactions: [],
    turnCount: 0,
    lastResponse: null,
    timedOut: false,
    aborted: false,
    currentPrompt: prompt,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Loop phases
// ─────────────────────────────────────────────────────────────────────────────

/** The pre-aborted zero-cost row — US-002: priced from nothing, but the card is named. */
export function zeroCostAbortedResult(frame: SendTurnFrame): TurnResult {
  return {
    output: "",
    tokenUsage: { inputTokens: 0, outputTokens: 0 },
    estimatedCostUsd: 0,
    internalRoundTrips: 0,
    // US-002: openSession already resolved the card. Zero cost, but a
    // consumer can still tell this row's card from the derived fallback.
    pricingSource: frame.rateCard.source,
  };
}

type BeginTurnOutcome = { kind: "break" } | { kind: "response"; response: AcpSessionResponse };

/** The iteration prologue: deadline check, counter, prompt round-trip, timeout/abort checks. */
async function beginTurnIteration(frame: SendTurnFrame, state: SendTurnState): Promise<BeginTurnOutcome> {
  if (frame.turnDeadline.expired()) {
    state.timedOut = true;
    warnWallClockTimeout(frame.sessionName, frame.timeoutSeconds);
    return { kind: "break" };
  }
  state.turnCount++;
  getSafeLogger()?.debug("acp-adapter", `Session turn ${state.turnCount}/${frame.maxInteractions}`, {
    sessionName: frame.sessionName,
  });

  const turnResult = await runSessionPrompt(
    frame.impl._session,
    state.currentPrompt,
    frame.turnDeadline.remainingMs() ?? 0,
    frame.opts.signal,
  );

  if (turnResult.timedOut) {
    state.timedOut = true;
    warnWallClockTimeout(frame.sessionName, frame.timeoutSeconds);
    return { kind: "break" };
  }
  if (turnResult.aborted) {
    state.aborted = true;
    return { kind: "break" };
  }

  state.lastResponse = turnResult.response;
  if (!state.lastResponse) return { kind: "break" };
  return { kind: "response", response: state.lastResponse };
}

/**
 * NO_SESSION recovery: acpx session expired server-side (exit code 4).
 * Re-establish and retry this turn once — don't count the dead attempt.
 * Returns true when the turn was re-queued (caller continues the loop).
 *
 * ADR-019 boundary note: ADR-019 §2 makes SessionManager the owner of session
 * lifecycle (open/close, descriptor state, turn count). This recovery
 * intentionally does NOT involve SessionManager — it is a transport-level
 * reconnect of the underlying acpx session, analogous to a TCP reconnect under
 * an HTTP keep-alive. The SessionManager-facing identity (`handle.id`,
 * `_sessionName`) is unchanged; descriptor state stays `RUNNING`; only the
 * opaque `_session` pointer is swapped. If future recovery work needs to
 * reset descriptor state or invalidate turn count, that belongs in
 * SessionManager.runInSession (catch a typed RetryableSessionError from the
 * adapter and call `openSession` again at the orchestrator layer).
 */
async function recoverNoSession(frame: SendTurnFrame, state: SendTurnState): Promise<boolean> {
  if (state.lastResponse?.exitCode !== 4 || state.sessionRecreated) {
    return false;
  }
  state.sessionRecreated = true;
  getSafeLogger()?.info("acp-adapter", "NO_SESSION detected — re-establishing session", {
    sessionName: frame.sessionName,
  });
  try {
    const ensured = await ensureAcpSession(
      frame.impl._client,
      frame.impl._sessionName,
      frame.impl.agentName,
      frame.impl._permissionMode,
    );
    frame.impl._session = ensured.session;
    state.turnCount--;
    return true;
  } catch (err) {
    getSafeLogger()?.warn("acp-adapter", "Session re-establishment failed after NO_SESSION", {
      sessionName: frame.sessionName,
      error: err instanceof Error ? err.message : String(err),
    });
    // Fall through to error throw at end of loop
    return false;
  }
}

function accumulateUsage(frame: SendTurnFrame, state: SendTurnState, response: AcpSessionResponse): void {
  if (response.cumulative_token_usage) {
    state.totalTokenUsage = addTokenUsage(
      state.totalTokenUsage,
      frame.mapper.toInternal(response.cumulative_token_usage),
    );
  }
  if (response.exactCostUsd !== undefined) {
    state.totalExactCostUsd = (state.totalExactCostUsd ?? 0) + response.exactCostUsd;
  }
}

function replyContext(frame: SendTurnFrame): InteractionReplyContext {
  return { interactionHandler: frame.opts.interactionHandler, signal: frame.opts.signal, stage: "acp-adapter" };
}

async function handleContextToolCall(
  frame: SendTurnFrame,
  state: SendTurnState,
  toolCall: ContextToolCall,
): Promise<boolean> {
  const interaction = toContextToolInteraction(toolCall);

  // BUG-18 — this path previously raced only against `signal` (abort),
  // with no deadline: a hung interaction handler (e.g. a black-holing
  // webhook URL) stalled the story indefinitely. Mirrors the `question`
  // block below, which already races against INTERACTION_TIMEOUT_MS.
  const reply = await awaitInteractionReply(replyContext(frame), interaction, " for context-tool: ");
  if (reply.kind === "answered") {
    state.currentPrompt = reply.answer;
    return true;
  }
  if (reply.kind === "aborted") {
    state.aborted = true;
  }
  return false;
}

async function handleQuestion(frame: SendTurnFrame, state: SendTurnState, question: string): Promise<boolean> {
  const reply = await awaitInteractionReply(replyContext(frame), { kind: "question", text: question }, ": ");
  if (reply.kind === "answered") {
    state.interactions.push({ turnIndex: state.turnCount, question, reply: reply.answer });
    state.currentPrompt = reply.answer;
    return true;
  }
  if (reply.kind === "aborted") {
    state.aborted = true;
  }
  return false;
}

/** Classify the response's output: a context-tool pull or a human question continues the loop. */
async function processResponseInteractions(
  frame: SendTurnFrame,
  state: SendTurnState,
  response: AcpSessionResponse,
): Promise<"continue" | "break"> {
  const outputText = extractOutput(response);
  const isEndTurn = response.stopReason === "end_turn";

  if (isEndTurn) {
    const toolCall = extractContextToolCall(outputText);
    if (toolCall) {
      return (await handleContextToolCall(frame, state, toolCall)) ? "continue" : "break";
    }
    const question = extractQuestion(outputText);
    if (question) {
      return (await handleQuestion(frame, state, question)) ? "continue" : "break";
    }
  }
  return "break";
}

function maybeWarnBudgetSpent(frame: SendTurnFrame, state: SendTurnState): void {
  if (state.turnCount >= frame.maxInteractions && !state.timedOut && !state.aborted && frame.maxInteractions > 1) {
    getSafeLogger()?.warn("acp-adapter", "Interaction budget spent", {
      sessionName: frame.sessionName,
      maxInteractions: frame.maxInteractions,
    });
  }
}

function throwIfTurnFailed(frame: SendTurnFrame, state: SendTurnState): void {
  const lastResponse = state.lastResponse;
  if (lastResponse?.stopReason !== "error") {
    return;
  }
  // Surface transport facts (SessionManager maps `cancelled`->fail-stale;
  // build-hop-callback maps `retryable`). BUG-57: also carry accumulated cost.
  const hasUsage = state.totalTokenUsage.inputTokens > 0 || state.totalTokenUsage.outputTokens > 0;
  throw new SessionTurnError(
    lastResponse.cancelled
      ? "Agent session ended with stop reason: error (externally cancelled)"
      : "Agent session ended with stop reason: error",
    lastResponse.cancelled === true,
    lastResponse.retryable === true,
    state.totalTokenUsage,
    hasUsage ? estimateCostUsd(state.totalTokenUsage, frame.rateCard.rates) : 0,
    state.totalExactCostUsd,
    // US-002: name the card that priced the burned tokens so the error
    // row's estimate is attributable, like every other ACP result.
    frame.rateCard.source,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Loop driver
// ─────────────────────────────────────────────────────────────────────────────

export async function runTurnLoop(frame: SendTurnFrame, state: SendTurnState): Promise<TurnResult> {
  while (state.turnCount < frame.maxInteractions) {
    const began = await beginTurnIteration(frame, state);
    if (began.kind === "break") break;
    if (await recoverNoSession(frame, state)) continue;
    accumulateUsage(frame, state, began.response);
    if ((await processResponseInteractions(frame, state, began.response)) === "break") break;
  }

  maybeWarnBudgetSpent(frame, state);
  throwIfTurnFailed(frame, state);
  return buildTurnResult({
    lastResponse: state.lastResponse,
    totalTokenUsage: state.totalTokenUsage,
    totalExactCostUsd: state.totalExactCostUsd,
    turnCount: state.turnCount,
    interactions: state.interactions,
    timedOut: state.timedOut,
    rateCard: frame.rateCard,
  });
}
