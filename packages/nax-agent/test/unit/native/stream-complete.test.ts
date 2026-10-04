/**
 * S3-3 (spec 5.3): round trips call client.stream() and fold with nax-ai's own
 * collectStream, tapping text and thinking deltas. The fold is nax-ai's, so a
 * missing done, an error event and a synchronous validation throw behave
 * exactly as they did through complete().
 */
import { describe, expect, test } from "bun:test";
import {
  type Client,
  type ClientRequest,
  type ProtocolEvent,
  ProtocolStreamError,
  type ResolvedModel,
} from "@nathapp/nax-ai";
import type { StreamDelta } from "#src/native/session/turn-types";
import { streamComplete } from "#src/native/stream-complete";

const model: ResolvedModel = {
  id: "m",
  provider: "p",
  protocol: "openai-responses",
  pricing: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  supportsTools: true,
  thinkingLevels: [],
};
const req: ClientRequest = { messages: [{ role: "user", content: "hi" }], sessionId: "s1" };

function clientStreaming(events: readonly ProtocolEvent[], seen?: { model?: unknown; req?: unknown }): Client {
  return {
    model: async () => model,
    listModels: async () => [model],
    pricing: () => model.pricing,
    stream(m, r) {
      if (seen !== undefined) {
        seen.model = m;
        seen.req = r;
      }
      return (async function* scripted() {
        yield* events;
      })();
    },
    complete: async () => {
      throw new Error("round trips must not call complete()");
    },
    validate: () => {},
  };
}

const script: ProtocolEvent[] = [
  { type: "thinking-delta", text: "hm" },
  { type: "thinking", block: { text: "hm" } },
  { type: "text-delta", text: "he" },
  { type: "tool-call-partial", id: "c1", name: "Read", rawInput: "{" },
  { type: "text-delta", text: "llo" },
  { type: "tool-call", call: { id: "c1", name: "Read", input: {} } },
  { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } },
  { type: "usage", usage: { inputTokens: 9, outputTokens: 4 } },
  { type: "done", stopReason: "tool_use" },
];

describe("streamComplete", () => {
  test("folds with collectStream: joined text, last usage wins, calls and thinking kept", async () => {
    const result = await streamComplete(clientStreaming(script), model, req);
    expect(result).toEqual({
      text: "hello",
      usage: { inputTokens: 9, outputTokens: 4 },
      stopReason: "tool_use",
      toolCalls: [{ id: "c1", name: "Read", input: {} }],
      thinking: [{ text: "hm" }],
    });
  });

  test("taps only text and thinking deltas, in stream order", async () => {
    const deltas: StreamDelta[] = [];
    await streamComplete(clientStreaming(script), model, req, (d) => void deltas.push(d));
    expect(deltas).toEqual([
      { type: "thinking_delta", text: "hm" },
      { type: "text_delta", text: "he" },
      { type: "text_delta", text: "llo" },
    ]);
  });

  test("passes the model and request through unchanged", async () => {
    const seen: { model?: unknown; req?: unknown } = {};
    await streamComplete(clientStreaming(script, seen), model, req);
    expect(seen.model).toBe(model);
    expect(seen.req).toBe(req);
  });

  test("a throwing delta sink cannot change the result", async () => {
    const result = await streamComplete(clientStreaming(script), model, req, () => {
      throw new Error("sink exploded");
    });
    expect(result.text).toBe("hello");
  });

  test("an error event rejects with nax-ai's own ProtocolStreamError", async () => {
    const failing: ProtocolEvent[] = [
      { type: "text-delta", text: "partial" },
      { type: "error", error: { kind: "transport", message: "upstream idle timeout" } },
    ];
    const err = await streamComplete(clientStreaming(failing), model, req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProtocolStreamError);
    if (!(err instanceof ProtocolStreamError)) throw new Error("unreachable");
    expect(err.protocolError.kind).toBe("transport");
  });

  test("a stream without a done event rejects as truncated", async () => {
    const truncated: ProtocolEvent[] = [{ type: "text-delta", text: "cut" }];
    await expect(streamComplete(clientStreaming(truncated), model, req)).rejects.toThrow(
      "Protocol stream ended without a done event",
    );
  });

  test("a synchronous throw from stream() becomes a rejection", async () => {
    const client: Client = {
      ...clientStreaming(script),
      stream() {
        throw new Error("invalid header value");
      },
    };
    let pending: Promise<unknown> | undefined;
    expect(() => {
      pending = streamComplete(client, model, req);
    }).not.toThrow();
    await expect(pending).rejects.toThrow("invalid header value");
  });
});
