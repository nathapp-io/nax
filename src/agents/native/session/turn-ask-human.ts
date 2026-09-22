/**
 * The `ask_human` branch of the turn loop's tool-call batch.
 *
 * Extracted unchanged. It is not an ordinary tool call: no tool produced it,
 * so it deliberately fires no `before_tool`/`after_tool` event — a policy that
 * shapes tool output has nothing to shape here.
 */

import type { InteractionExchange, SendTurnOpts } from "@/agents/session-types";
import { buildToolResult, type ToolResultMessage } from "./tool-result";

export interface AskHumanOutcome {
  /** Appended to the message array by the caller. */
  readonly result: ToolResultMessage;
  /** Present only when a real exchange happened; the caller pushes it. */
  readonly exchange?: InteractionExchange;
}

export async function handleAskHumanCall(args: {
  readonly toolCallId: string;
  readonly question: string;
  readonly interactionsSoFar: number;
  readonly maxInteractions: number;
  readonly roundTrips: number;
  readonly interactionHandler: SendTurnOpts["interactionHandler"];
}): Promise<AskHumanOutcome> {
  const { toolCallId, question, interactionsSoFar, maxInteractions, roundTrips, interactionHandler } = args;

  // An unset budget (maxInteractions undefined -> 0) keeps the tool unadvertised
  // above AND refuses a call made anyway. "No budget configured" must not
  // read as "unlimited" — that inverts the property this budget provides.
  if (interactionsSoFar >= maxInteractions) {
    return {
      result: buildToolResult({
        toolCallId,
        content: "The human Q&A budget for this turn is spent. Proceed on your best judgement.",
        isError: true,
      }),
    };
  }

  const answer = await interactionHandler.onInteraction({ kind: "question", text: question });

  // A null answer means no operator is reachable — run-interaction-handler
  // returns null for kind:"question" when no interactionBridge is
  // configured. That is not an exchange: it must not consume budget and
  // must not be recorded as a question the operator answered with "".
  if (answer === null) {
    return {
      result: buildToolResult({
        toolCallId,
        content: "No human operator is available for this run. Proceed on your best judgement.",
        isError: true,
      }),
    };
  }

  return {
    result: buildToolResult({ toolCallId, content: answer.answer }),
    exchange: { turnIndex: roundTrips, question, reply: answer.answer },
  };
}
