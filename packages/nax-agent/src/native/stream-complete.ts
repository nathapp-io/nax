/**
 * One streamed model call (S3 spec 5.3, R7).
 *
 * nax-ai's `Client.complete()` is `collectStream(streamFrom(...))`, so the wire
 * was always a stream; this calls the same `stream()` and folds it with the
 * same `collectStream`, tapping text and thinking deltas on the way. The fold
 * is deliberately not reimplemented: last-usage-wins, the required `done` and
 * `ProtocolStreamError` on an `error` event are what the turn loop's retry and
 * overflow classifiers key on.
 *
 * `async` on purpose: `client.stream()` throws synchronously on an invalid
 * header or session id, and an async function turns that into a rejection,
 * exactly as `complete()` does. Without `onDelta` there is no tap at all.
 */

import {
  type Client,
  type ClientRequest,
  type CompleteResult,
  collectStream,
  type ProtocolEvent,
  type ResolvedModel,
} from "@nathapp/nax-ai";
import type { StreamDelta, StreamDeltaSink } from "./session/turn-types.ts";

function deltaOf(event: ProtocolEvent): StreamDelta | undefined {
  if (event.type === "text-delta") return { type: "text_delta", text: event.text };
  if (event.type === "thinking-delta") return { type: "thinking_delta", text: event.text };
  return undefined;
}

async function* tap(events: AsyncIterable<ProtocolEvent>, onDelta: StreamDeltaSink): AsyncIterable<ProtocolEvent> {
  for await (const event of events) {
    const delta = deltaOf(event);
    if (delta !== undefined) {
      try {
        onDelta(delta);
      } catch {
        // A display sink must not break the call; the emitter already logs its own failures.
      }
    }
    yield event;
  }
}

export async function streamComplete(
  client: Client,
  model: ResolvedModel,
  req: ClientRequest,
  onDelta?: StreamDeltaSink,
): Promise<CompleteResult> {
  const events = client.stream(model, req);
  return collectStream(onDelta === undefined ? events : tap(events, onDelta));
}
