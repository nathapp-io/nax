/**
 * One ACP prompt turn (S4 spec §6.3 steps 2 and 3, §5.7, §6.7). The response settles
 * the turn's collector first, so its usage event goes out for every stop reason
 * (S4-5 D5-h); end_turn then returns a TurnResult with the turn's tokens and cost,
 * and any other stop reason throws its ACP_STOP_* NaxError with the turn's spend
 * attached (#2367). When the turn signal aborts (cancel(), the facade's turn
 * timeout, close()), session/cancel is sent and the prompt gets cancelGraceMs to
 * settle; an answer inside it settles the collector and its spend is attached to
 * the thrown reason; past that the process group is killed
 * and the session is marked disconnected. The facade reports cancelled or timed_out
 * from the signal, so after an abort this throws the signal's reason.
 */
import type { PromptResponse } from "@agentclientprotocol/sdk";
import { attachTurnSpend, type FailedTurnSpend, NaxError, type TurnResult } from "@nathapp/nax-agent";
import type { AcpLink } from "#src/client/connection";
import { promptRequestError, rpcErrorOf, stopReasonError } from "#src/client/errors";
import type { TurnCollector } from "#src/client/events";
import { agentGoneError, type LaunchedAgent } from "#src/client/launch";
import { race } from "#src/client/race";

export interface TurnState {
  readonly link: AcpLink;
  readonly launched: LaunchedAgent;
  readonly agentSessionId: string;
  readonly cancelGraceMs: number;
  readonly secrets: readonly string[];
  /** Marks the session disconnected: its process is gone or was killed (D-f). */
  disconnect(): void;
}

export interface TurnInput {
  readonly text: string;
  readonly signal: AbortSignal;
  readonly collector: TurnCollector;
}

/** A turn that ended with no prompt response reports nothing it can price; its reading moves to the next turn. */
const NO_RESPONSE_SPEND: FailedTurnSpend = Object.freeze({
  tokenUsage: Object.freeze({ inputTokens: 0, outputTokens: 0 }),
  costUsd: 0,
  costSource: "unpriced",
});

export async function runPromptTurn(state: TurnState, input: TurnInput): Promise<TurnResult> {
  const pending = state.link.prompt({
    sessionId: state.agentSessionId,
    prompt: [{ type: "text", text: input.text }],
  });
  const outcome = await race(pending, { signal: input.signal });
  switch (outcome.kind) {
    case "ok":
      return resultOf(outcome.value, input.collector);
    case "failed": {
      const error = await promptFailure(state, outcome.error);
      attachTurnSpend(error, NO_RESPONSE_SPEND);
      throw error;
    }
    default: {
      const response = await cancelTurn(state, pending);
      const reason = abortReason(input.signal);
      // #2367: an answer inside the grace still reports what the turn spent.
      attachTurnSpend(reason, response === undefined ? NO_RESPONSE_SPEND : input.collector.settle(response));
      throw reason;
    }
  }
}

function resultOf(response: PromptResponse, collector: TurnCollector): TurnResult {
  const spend = collector.settle(response);
  if (response.stopReason !== "end_turn") {
    const error = stopReasonError(String(response.stopReason));
    attachTurnSpend(error, spend);
    throw error;
  }
  return {
    output: collector.output(),
    tokenUsage: spend.tokenUsage,
    estimatedCostUsd: spend.costUsd,
    costSource: spend.costSource,
    internalRoundTrips: 1,
  };
}

async function promptFailure(state: TurnState, error: unknown): Promise<NaxError> {
  const rpc = rpcErrorOf(error);
  if (rpc !== undefined) return promptRequestError(rpc, state.secrets);
  state.disconnect();
  return agentGoneError("session/prompt", state.launched, state.secrets);
}

/** session/cancel, then cancelGraceMs for the prompt to answer; past that the process is killed. */
async function cancelTurn(state: TurnState, pending: Promise<PromptResponse>): Promise<PromptResponse | undefined> {
  await state.link.cancel(state.agentSessionId).catch(() => undefined);
  const settled = await race(pending, { timeoutMs: state.cancelGraceMs });
  if (settled.kind === "ok") return settled.value;
  if (settled.kind === "timeout") {
    state.launched.kill();
    state.disconnect();
  }
  return undefined;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new NaxError("The turn was aborted", "AGENT_SESSION_TURN_FAILED", { stage: "acp" });
}
