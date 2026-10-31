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
 *
 * nax#2582: an agent may answer a denied permission request by cancelling its own
 * turn (codex-acp's sandbox escalation offers only `cancel` as a reject). When a
 * prompt stops "cancelled", the turn signal has not aborted, and the turn denied a
 * request during that prompt, the same turn sends DENIED_CONTINUATION_PROMPT, at
 * most MAX_DENIED_CONTINUATIONS times; the prompts' usage is summed into the one
 * TurnResult. Past the bound the turn ends ACP_STOP_CANCELLED as before.
 *
 * nax#2591: an end_turn that showed no work and reported no tokens throws
 * ACP_EMPTY_TURN: an agent that swallows its model call's failure (pi-acp on a
 * provider 402) answers end_turn, and the turn must not read as completed.
 */
import type { PromptResponse } from "@agentclientprotocol/sdk";
import {
  attachTurnSpend,
  type FailedTurnSpend,
  type ImageAttachment,
  NaxError,
  type TurnResult,
} from "@nathapp/nax-agent";
import type { AcpLink } from "#src/client/connection";
import { emptyTurnError, promptRequestError, rpcErrorOf, stopReasonError } from "#src/client/errors";
import type { TurnCollector } from "#src/client/events";
import { agentGoneError, type LaunchedAgent } from "#src/client/launch";
import { race } from "#src/client/race";
import { sumUsage, tokenUsageOf } from "#src/client/usage";

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
  readonly images?: readonly ImageAttachment[];
  readonly signal: AbortSignal;
  readonly collector: TurnCollector;
}

/** A turn that ended with no prompt response reports nothing it can price; its reading moves to the next turn. */
const NO_RESPONSE_SPEND: FailedTurnSpend = Object.freeze({
  tokenUsage: Object.freeze({ inputTokens: 0, outputTokens: 0 }),
  costUsd: 0,
  costSource: "unpriced",
});

/** Follow-up prompts one turn may send after a deny made the agent cancel (nax#2582). */
export const MAX_DENIED_CONTINUATIONS = 2;

export const DENIED_CONTINUATION_PROMPT =
  "A permission request you made was denied by this session's permission policy, and the denial stopped your turn. " +
  "Continue the same task without that action. Do not request that permission again; if the task cannot be " +
  "finished without it, say so in your reply.";

export async function runPromptTurn(state: TurnState, input: TurnInput): Promise<TurnResult> {
  let text = input.text;
  let carried: PromptResponse["usage"];
  for (let continuation = 0; ; continuation += 1) {
    const denialsBefore = input.collector.denials();
    const response = await promptOnce(state, input, { text, carried, firstPrompt: continuation === 0 });
    const usage = sumUsage(carried, response.usage);
    const continueAfterDenial =
      response.stopReason === "cancelled" &&
      !input.signal.aborted &&
      input.collector.denials() > denialsBefore &&
      continuation < MAX_DENIED_CONTINUATIONS;
    if (!continueAfterDenial) return resultOf({ ...response, usage }, input.collector, continuation + 1);
    carried = usage;
    text = DENIED_CONTINUATION_PROMPT;
  }
}

/**
 * One session/prompt. A failed request throws with the tokens of the prompts this turn
 * already answered and no cost (the cost reading moves to the next turn); an abort
 * throws with the spend of every prompt this turn answered.
 */
async function promptOnce(
  state: TurnState,
  input: TurnInput,
  prompt: { text: string; carried: PromptResponse["usage"]; firstPrompt: boolean },
): Promise<PromptResponse> {
  const { text, carried, firstPrompt } = prompt;
  const images = firstPrompt ? (input.images ?? []) : [];
  const pending = state.link.prompt({
    sessionId: state.agentSessionId,
    prompt: [
      ...images.map((image) => ({ type: "image" as const, mimeType: image.mimeType, data: image.data })),
      { type: "text", text },
    ],
  });
  const outcome = await race(pending, { signal: input.signal });
  switch (outcome.kind) {
    case "ok":
      return outcome.value;
    case "failed": {
      const error = await promptFailure(state, outcome.error);
      attachTurnSpend(
        error,
        carried === undefined ? NO_RESPONSE_SPEND : { ...NO_RESPONSE_SPEND, tokenUsage: tokenUsageOf(carried) },
      );
      throw error;
    }
    default: {
      const response = await cancelTurn(state, pending);
      const reason = abortReason(input.signal);
      // #2367: an answer inside the grace still reports what the turn spent.
      attachTurnSpend(
        reason,
        response === undefined
          ? NO_RESPONSE_SPEND
          : input.collector.settle({ ...response, usage: sumUsage(carried, response.usage) }),
      );
      throw reason;
    }
  }
}

function resultOf(response: PromptResponse, collector: TurnCollector, prompts: number): TurnResult {
  const spend = collector.settle(response);
  const idle = !collector.worked() && spend.tokenUsage.inputTokens === 0 && spend.tokenUsage.outputTokens === 0;
  if (response.stopReason !== "end_turn" || idle) {
    const error = response.stopReason === "end_turn" ? emptyTurnError() : stopReasonError(String(response.stopReason));
    attachTurnSpend(error, spend);
    throw error;
  }
  return {
    output: collector.output(),
    tokenUsage: spend.tokenUsage,
    estimatedCostUsd: spend.costUsd,
    costSource: spend.costSource,
    internalRoundTrips: prompts,
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
  // A backpressured stdin can block the notification itself. Start the grace
  // without waiting for that write so cancellation still reaches the kill path.
  void state.link.cancel(state.agentSessionId).catch(() => undefined);
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
