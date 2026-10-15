/**
 * Derives a single result from a protocol stream.
 *
 * Implemented once, here, rather than per protocol — that is why `Protocol`
 * exposes only `stream`. A backend cannot let a request/response path drift
 * from its streaming path if it never writes one.
 */

import type { CompleteResult, TokenUsage } from "../types.ts";
import type { ProtocolError, ProtocolEvent, ThinkingBlock, ToolCall } from "./types.ts";

const EMPTY_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0 };

/**
 * Usage billed by a round trip that then failed, for errors that are not a
 * `ProtocolStreamError` (a caller abort thrown mid-stream). Keyed on identity so
 * the thrown value is never mutated or wrapped.
 */
const partialUsageByError = new WeakMap<object, TokenUsage>();

export class ProtocolStreamError extends Error {
  /**
   * Tokens the provider billed before the stream failed, when it reported any.
   * A failed request still bills; dropping this made every retry and abort undercount.
   */
  readonly usage?: TokenUsage;

  constructor(
    readonly protocolError: ProtocolError,
    usage?: TokenUsage,
  ) {
    super(protocolError.message);
    if (usage !== undefined) this.usage = usage;
    this.name = "ProtocolStreamError";
    if (protocolError.cause !== undefined) this.cause = protocolError.cause;
  }
}

/** The usage a failed `collectStream` call had already been billed, or undefined when none was reported. */
export function partialUsageOf(err: unknown): TokenUsage | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  return err instanceof ProtocolStreamError ? err.usage : partialUsageByError.get(err);
}

export async function collectStream(events: AsyncIterable<ProtocolEvent>): Promise<CompleteResult> {
  let usage: TokenUsage | undefined;
  try {
    return await foldStream(events, (u) => {
      usage = u;
    });
  } catch (err) {
    if (usage !== undefined && typeof err === "object" && err !== null && !(err instanceof ProtocolStreamError)) {
      partialUsageByError.set(err, usage);
    }
    throw err;
  }
}

async function foldStream(
  events: AsyncIterable<ProtocolEvent>,
  onUsage: (u: TokenUsage) => void,
): Promise<CompleteResult> {
  const text: string[] = [];
  const toolCalls: ToolCall[] = [];
  const thinking: ThinkingBlock[] = [];
  let usage: TokenUsage | undefined;
  let stopReason: CompleteResult["stopReason"] | undefined;
  let identity: { responseId?: string; responseModel?: string } = {};

  for await (const event of events) {
    switch (event.type) {
      case "text-delta":
        text.push(event.text);
        break;
      case "tool-call":
        toolCalls.push(event.call);
        break;
      case "thinking":
        // Without this, complete() has no way to hand a caller the block
        // needed to replay the next turn — the whole point of the fix.
        thinking.push(event.block);
        break;
      case "usage":
        usage = event.usage;
        onUsage(usage);
        break;
      case "error":
        throw new ProtocolStreamError(event.error, usage);
      case "done":
        stopReason = event.stopReason;
        identity = {
          ...(event.responseId !== undefined ? { responseId: event.responseId } : {}),
          ...(event.responseModel !== undefined ? { responseModel: event.responseModel } : {}),
        };
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
    ...(thinking.length > 0 ? { thinking } : {}),
    ...identity,
  };
  return result;
}
