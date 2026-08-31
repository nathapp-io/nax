/**
 * Derives a single result from a protocol stream.
 *
 * Implemented once, here, rather than per protocol — that is why `Protocol`
 * exposes only `stream`. A backend cannot let a request/response path drift
 * from its streaming path if it never writes one.
 */

import type { CompleteResult, TokenUsage } from "../types.ts";
import type { ProtocolError, ProtocolEvent, ToolCall } from "./types.ts";

const EMPTY_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0 };

export class ProtocolStreamError extends Error {
  constructor(readonly protocolError: ProtocolError) {
    super(protocolError.message);
    this.name = "ProtocolStreamError";
    if (protocolError.cause !== undefined) this.cause = protocolError.cause;
  }
}

export async function collectStream(events: AsyncIterable<ProtocolEvent>): Promise<CompleteResult> {
  const text: string[] = [];
  const toolCalls: ToolCall[] = [];
  let usage: TokenUsage | undefined;
  let stopReason: CompleteResult["stopReason"] | undefined;

  for await (const event of events) {
    switch (event.type) {
      case "text-delta":
        text.push(event.text);
        break;
      case "tool-call":
        toolCalls.push(event.call);
        break;
      case "usage":
        usage = event.usage;
        break;
      case "error":
        throw new ProtocolStreamError(event.error);
      case "done":
        stopReason = event.stopReason;
        break;
      // Thinking text is not part of the answer, and a partial tool call is
      // superseded by the "tool-call" event that follows it.
      case "thinking-delta":
      case "tool-call-partial":
        break;
    }
  }

  if (stopReason === undefined) {
    throw new Error("Protocol stream ended without a done event — the response was truncated.");
  }

  const result: CompleteResult = {
    text: text.join(""),
    usage: usage ?? EMPTY_USAGE,
    stopReason,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
  return result;
}
