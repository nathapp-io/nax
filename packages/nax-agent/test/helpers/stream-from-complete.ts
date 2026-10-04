/**
 * Derives a fake nax-ai client's `stream()` from its scripted `complete()` (S3-3).
 *
 * From S3-3 the native adapter's round trips stream, while most fakes script
 * `complete()`. Deriving one from the other keeps each fake's script the single
 * source of its replies, and a counter on `complete()` keeps counting. The
 * events fold back to exactly the scripted result through nax-ai's
 * `collectStream` (pinned by stream-from-complete-helper.test.ts).
 */
import type { Client, ClientRequest, CompleteResult, ProtocolEvent, ResolvedModel } from "@nathapp/nax-ai";

export function eventsFromResult(result: CompleteResult): ProtocolEvent[] {
  const thinking = (result.thinking ?? []).flatMap((block): ProtocolEvent[] => [
    { type: "thinking-delta", text: block.text },
    { type: "thinking", block },
  ]);
  const text: ProtocolEvent[] = result.text.length > 0 ? [{ type: "text-delta", text: result.text }] : [];
  const calls = (result.toolCalls ?? []).map((call): ProtocolEvent => ({ type: "tool-call", call }));
  const done: ProtocolEvent = {
    type: "done",
    stopReason: result.stopReason,
    ...(result.responseId !== undefined ? { responseId: result.responseId } : {}),
    ...(result.responseModel !== undefined ? { responseModel: result.responseModel } : {}),
  };
  return [...thinking, ...text, ...calls, { type: "usage", usage: result.usage }, done];
}

export function streamFromComplete(complete: Client["complete"]): Client["stream"] {
  return async function* derivedStream(model: ResolvedModel, req: ClientRequest) {
    yield* eventsFromResult(await complete(model, req));
  };
}

/** Replaces `client.stream` with one derived from `client.complete`, looked up at call time. */
export function withDerivedStream<C extends Client>(client: C): C {
  return { ...client, stream: streamFromComplete((model, req) => client.complete(model, req)) };
}
