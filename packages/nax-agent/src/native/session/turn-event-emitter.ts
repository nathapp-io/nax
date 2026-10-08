/**
 * The one caller of an embedder's `onTurnEvent` sink (S3-3).
 *
 * Built once per turn by `runNativeTurn`. Every method is a no-op without a
 * sink, so nax (which sets none) does no redaction or encoding work. The
 * emitter owns every branch the event sites would otherwise need, which keeps
 * `runToolBatch` and `sendTurn` free of new branches (complexity ratchet).
 *
 * - A sink that throws, or returns a promise that rejects, is contained and
 *   logged once per turn: an embedder's bug must not end a turn, a tool call
 *   or a Node process (an unhandled rejection does, by default).
 * - Tool input is redacted with the logger's redactor before it leaves; the
 *   result preview first cuts to `REDACTION_SCAN_BYTES` to bound the scan,
 *   redacts, then cuts to `TOOL_RESULT_PREVIEW_BYTES` on a codepoint boundary.
 *   The final cut follows redaction so it cannot split a secret into a prefix
 *   the patterns no longer match.
 * - `toolResult` reports only a call `toolCall` reported (counted per id), and
 *   `flushUnanswered` answers what is left when a turn throws, so a consumer
 *   sees each `tool_call` answered by exactly one `tool_result`.
 * - Redaction is best-effort (see `TurnEvent`'s doc) and runs over a bounded
 *   prefix: a result can be up to 2 MB when no truncation handler ran.
 */

import type { ToolCall } from "@nathapp/nax-ai";
import type { TokenUsage } from "#src/cost/standard-types";
import { errorMessage } from "#src/infra/errors";
import { getSafeLogger } from "#src/infra/index";
import { capStrings, redactSecrets } from "#src/internal/redact";
import { isThenable } from "#src/internal/thenable";
import type { TurnEvent, TurnEventSink } from "#src/session/turn-event";
import { cutToByteCap } from "#src/tools/truncate";
import type { ToolResultMessage } from "./tool-result.ts";
import { cacheUsageFields } from "./turn-types.ts";

/** Byte cap on `tool_result.preview`. A preview is for display; the transcript holds the full result. */
export const TOOL_RESULT_PREVIEW_BYTES = 4096;

/** Byte cap on `tool_call.input` as JSON; a larger input becomes `{ truncated: true, preview }`. */
export const TOOL_CALL_INPUT_BYTES = 8192;

/** Redaction scans at most this many bytes of a result, and of each string in a tool input; the preview keeps far fewer. */
const REDACTION_SCAN_BYTES = TOOL_RESULT_PREVIEW_BYTES * 16;

const UNANSWERED_PREVIEW = "Not answered: the turn ended.";

/** One streamed delta, before the loop stamps its round. */
export interface StreamDelta {
  readonly type: "text_delta" | "thinking_delta";
  readonly text: string;
}

export type StreamDeltaSink = (delta: StreamDelta) => void;

export interface TurnEventEmitter {
  emit(event: TurnEvent): void;
  /** A delta sink stamped with `round`; undefined without a sink, so the adapter's tap stays a pass-through. */
  deltaSink(round: number): StreamDeltaSink | undefined;
  /** `recordedInput` is a `before_tool` rewrite when there is one; otherwise the model's `call.input` is reported. */
  toolCall(call: ToolCall, recordedInput: unknown): void;
  toolResult(result: ToolResultMessage): void;
  /** Answers every outstanding `tool_call` with an error result. Called from the turn's catch block. */
  flushUnanswered(): void;
}

export function usageEvent(round: number, usage: TokenUsage, costUsd: number): TurnEvent {
  return {
    type: "usage",
    round,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...cacheUsageFields(usage),
    costUsd,
  };
}

/** The masking and cap live `tool_call.input` gets; exported for ACP replay (S5-1). */
export function displayToolInput(input: unknown): unknown {
  const redacted = redactSecrets(capStrings(input, REDACTION_SCAN_BYTES));
  let json: string;
  try {
    json = JSON.stringify(redacted) ?? "null";
  } catch {
    return { truncated: true, preview: "[input not serializable]" };
  }
  if (Buffer.byteLength(json, "utf8") <= TOOL_CALL_INPUT_BYTES) return redacted;
  return { truncated: true, preview: cutToByteCap(json, TOOL_CALL_INPUT_BYTES) };
}

/** The masking and cap live `tool_result.preview` gets; exported for ACP replay (S5-1). */
export function toolResultPreview(content: string): string {
  return cutToByteCap(redactSecrets(cutToByteCap(content, REDACTION_SCAN_BYTES)), TOOL_RESULT_PREVIEW_BYTES);
}

const NOOP_EMITTER: TurnEventEmitter = {
  emit: () => {},
  deltaSink: () => undefined,
  toolCall: () => {},
  toolResult: () => {},
  flushUnanswered: () => {},
};

export function createTurnEventEmitter(sink: TurnEventSink | undefined): TurnEventEmitter {
  if (sink === undefined) return NOOP_EMITTER;
  let warned = false;
  /** Outstanding tool calls per id: a provider can repeat an id within a batch. */
  const outstanding = new Map<string, number>();

  const contain = (event: TurnEvent, err: unknown): void => {
    if (warned) return;
    warned = true;
    try {
      getSafeLogger()?.warn("native-turn-events", "onTurnEvent sink failed; events are still delivered", {
        eventType: event.type,
        error: errorMessage(err),
      });
    } catch {
      // The containment path itself must never throw or reject.
    }
  };

  const emit = (event: TurnEvent): void => {
    try {
      const returned: unknown = sink(event);
      if (isThenable(returned)) returned.then(undefined, (err: unknown) => contain(event, err));
    } catch (err) {
      contain(event, err);
    }
  };

  return {
    emit,
    deltaSink: (round) => (delta) => emit({ ...delta, round }),
    toolCall(call, recordedInput) {
      // Capped BEFORE the count moves: a throwing input (a hostile getter or
      // proxy) must not leave an outstanding call the matching toolResult then
      // answers with no preceding tool_call.
      const input = displayToolInput(recordedInput ?? call.input);
      outstanding.set(call.id, (outstanding.get(call.id) ?? 0) + 1);
      emit({ type: "tool_call", callId: call.id, name: call.name, input });
    },
    toolResult(result) {
      const count = outstanding.get(result.toolCallId) ?? 0;
      if (count === 0) return;
      if (count === 1) outstanding.delete(result.toolCallId);
      else outstanding.set(result.toolCallId, count - 1);
      emit({
        type: "tool_result",
        callId: result.toolCallId,
        isError: result.isError === true,
        preview: toolResultPreview(result.content),
      });
    },
    flushUnanswered() {
      for (const [callId, count] of outstanding) {
        for (let i = 0; i < count; i += 1) {
          emit({ type: "tool_result", callId, isError: true, preview: UNANSWERED_PREVIEW });
        }
      }
      outstanding.clear();
    },
  };
}
