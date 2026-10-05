/**
 * One ACP prompt turn (S4 spec §6.3 steps 2 and 3, §5.7). end_turn returns a
 * TurnResult; any other stop reason throws its ACP_STOP_* NaxError. When the turn
 * signal aborts (cancel(), the facade's turn timeout, close()), session/cancel is
 * sent and the prompt gets cancelGraceMs to settle; past that the process group
 * is killed and the session is marked disconnected. The facade reports cancelled
 * or timed_out from the signal, so after an abort this throws the signal's reason.
 */
import type { PromptResponse } from "@agentclientprotocol/sdk";
import { NaxError, type TurnResult } from "@nathapp/nax-agent";
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

export async function runPromptTurn(state: TurnState, input: TurnInput): Promise<TurnResult> {
  const pending = state.link.prompt({
    sessionId: state.agentSessionId,
    prompt: [{ type: "text", text: input.text }],
  });
  const outcome = await race(pending, { signal: input.signal });
  switch (outcome.kind) {
    case "ok":
      return resultOf(outcome.value, input.collector);
    case "failed":
      throw await promptFailure(state, outcome.error);
    default:
      await cancelTurn(state, pending);
      throw abortReason(input.signal);
  }
}

function resultOf(response: PromptResponse, collector: TurnCollector): TurnResult {
  if (response.stopReason !== "end_turn") throw stopReasonError(String(response.stopReason));
  // Usage and cost arrive with S4-5 (§6.7); until then a turn is unpriced zeros (D-e).
  return {
    output: collector.output(),
    tokenUsage: { inputTokens: 0, outputTokens: 0 },
    estimatedCostUsd: 0,
    costSource: "unpriced",
    internalRoundTrips: 1,
  };
}

async function promptFailure(state: TurnState, error: unknown): Promise<NaxError> {
  const rpc = rpcErrorOf(error);
  if (rpc !== undefined) return promptRequestError(rpc, state.secrets);
  state.disconnect();
  return agentGoneError("session/prompt", state.launched, state.secrets);
}

async function cancelTurn(state: TurnState, pending: Promise<PromptResponse>): Promise<void> {
  await state.link.cancel(state.agentSessionId).catch(() => undefined);
  const settled = await race(pending, { timeoutMs: state.cancelGraceMs });
  if (settled.kind === "timeout") {
    state.launched.kill();
    state.disconnect();
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new NaxError("The turn was aborted", "AGENT_SESSION_TURN_FAILED", { stage: "acp" });
}
