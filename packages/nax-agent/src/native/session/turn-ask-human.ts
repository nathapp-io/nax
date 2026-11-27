/**
 * The `ask_human` branch of the turn loop's tool-call batch.
 *
 * Extracted unchanged. It is not an ordinary tool call: no tool produced it,
 * so it deliberately fires no `before_tool`/`after_tool` event — a policy that
 * shapes tool output has nothing to shape here.
 *
 * US-002 split it in two: `runAskHumanCall` reads the model's call (parsing an
 * optional `questions` set and refusing a malformed one without asking
 * anyone), and `handleAskHumanCall` performs the ask. Keeping the parse here
 * rather than inline in the batch keeps `runToolBatch` under the complexity
 * gate, and keeps every rule of this one branch in the module that owns it.
 */

import type { ToolCall } from "@nathapp/nax-ai";
import { type ChoiceQuestion, parseChoiceQuestions, renderChoiceQuestionsText } from "#src/session/choice-questions";
import type { AdapterInteraction } from "#src/session/interaction-handler";
import type { InteractionExchange, SendTurnOpts } from "#src/session/session-types";
import { NATIVE_CHOICE_MAX_OPTIONS } from "./ask-human.ts";
import { buildToolResult, type ToolResultMessage } from "./tool-result.ts";

export interface AskHumanOutcome {
  /** Appended to the message array by the caller. */
  readonly result: ToolResultMessage;
  /** Present only when a real exchange happened; the caller pushes it. */
  readonly exchange?: InteractionExchange;
}

/**
 * US-002: what an `ask_human` call's `questions` input yielded. An absent input
 * is the plain text ask (no `questions` on the request at all); a present but
 * malformed one carries the parser's reason.
 */
type NativeQuestions =
  | { readonly ok: true; readonly questions?: readonly ChoiceQuestion[] }
  | { readonly ok: false; readonly reason: string };

/** Prefix on every malformed-`questions` answer, so the model can tell a refused set from a tool error. */
const INVALID_QUESTIONS_PREFIX = "Invalid questions: ";

function readNativeQuestions(input: unknown): NativeQuestions {
  if (input === undefined) return { ok: true };
  const parsed = parseChoiceQuestions(input, { maxOptions: NATIVE_CHOICE_MAX_OPTIONS, allowOther: true });
  return parsed.ok ? { ok: true, questions: parsed.questions } : { ok: false, reason: parsed.reason };
}

/**
 * The whole branch for one model call: read the questions, then ask. A
 * malformed `questions` set answers the call with the parser's reason — the
 * model can fix the one field it got wrong — and asks nobody: no interaction,
 * and no budget spent, so a corrected second call in the same turn is still
 * answerable. The parse is the gate the schema cannot be (a provider may ignore
 * it).
 */
export async function runAskHumanCall(args: {
  readonly toolCall: ToolCall;
  readonly interactionsSoFar: number;
  readonly maxInteractions: number;
  readonly roundTrips: number;
  readonly interactionHandler: SendTurnOpts["interactionHandler"];
}): Promise<AskHumanOutcome> {
  const { toolCall, interactionsSoFar, maxInteractions, roundTrips, interactionHandler } = args;
  const input: { text?: unknown; questions?: unknown } | undefined = toolCall.input as
    | { text?: unknown; questions?: unknown }
    | undefined;
  const choice = readNativeQuestions(input?.questions);
  if (!choice.ok) {
    return {
      result: buildToolResult({
        toolCallId: toolCall.id,
        content: `${INVALID_QUESTIONS_PREFIX}${choice.reason}`,
        isError: true,
      }),
    };
  }
  return handleAskHumanCall({
    toolCallId: toolCall.id,
    question: String(input?.text ?? ""),
    ...(choice.questions !== undefined ? { questions: choice.questions } : {}),
    interactionsSoFar,
    maxInteractions,
    roundTrips,
    interactionHandler,
  });
}

export async function handleAskHumanCall(args: {
  readonly toolCallId: string;
  readonly question: string;
  /**
   * US-002: the parsed choice questions the call carried. Present only for a
   * choice ask — the plain `{ text }` ask sends exactly `{ kind, text }`, so a
   * handler written against the old request shape sees no difference.
   */
  readonly questions?: readonly ChoiceQuestion[];
  readonly interactionsSoFar: number;
  readonly maxInteractions: number;
  readonly roundTrips: number;
  readonly interactionHandler: SendTurnOpts["interactionHandler"];
}): Promise<AskHumanOutcome> {
  const { toolCallId, question, questions, interactionsSoFar, maxInteractions, roundTrips, interactionHandler } = args;

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

  // A choice ask renders its prompt and numbered options into `text`, so a
  // handler that reads only `text` still shows every option; the parsed
  // questions ride along for a handler that can draw them as a form or card.
  const text = questions === undefined ? question : renderChoiceQuestionsText(question, questions);
  const request: AdapterInteraction =
    questions === undefined ? { kind: "question", text } : { kind: "question", text, prompt: question, questions };
  const answer = await interactionHandler.onInteraction(request);

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
    exchange: { turnIndex: roundTrips, question: text, reply: answer.answer },
  };
}
