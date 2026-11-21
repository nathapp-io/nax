import type { Api, AssistantMessageEvent, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ClientRequest, createClient, type ProtocolFactory } from "../../src/client.ts";
import { createMemoryCredentialStore } from "../../src/credentials/memory-store.ts";
import { createPiProtocol } from "../../src/protocols/pi-client.ts";
import { defaultProtocols } from "../../src/protocols/pi-protocols.ts";
import type { ProtocolEvent, ProtocolRequest } from "../../src/protocols/types.ts";
import { defaultProviders } from "../../src/providers/pi-catalog.ts";
import type { CompleteResult } from "../../src/types.ts";

const MODEL: Model<Api> = {
  id: "gpt-5.4",
  name: "GPT-5.4",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 8000,
};

const BASE: ProtocolRequest = { model: "gpt-5.4", messages: [{ role: "user", content: "hi" }] };

const LOOKUP_TOOL = {
  name: "lookup",
  description: "Look a city up",
  inputSchema: { type: "object", properties: { city: { type: "string" } } },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function fakePi(events: AssistantMessageEvent[]) {
  return {
    resolveModel: async () => MODEL,
    stream: (_model: Model<Api>, _context: Context, _options: SimpleStreamOptions, _onResponse: unknown) =>
      (async function* () {
        for (const event of events) yield event;
      })(),
  };
}

function message(overrides: Record<string, unknown> = {}) {
  return {
    role: "assistant" as const,
    content: [],
    api: "openai-responses" as Api,
    provider: "openai",
    model: "gpt-5.4",
    usage: {
      input: 10,
      output: 4,
      cacheRead: 2,
      cacheWrite: 1,
      totalTokens: 17,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: 0,
    ...overrides,
  };
}

/** The in-progress `t1` block the partial carries, which is where a delta finds id and name. */
function partialWithCall() {
  return message({ content: [{ type: "toolCall", id: "t1", name: "lookup", arguments: {} }] });
}

function argumentsDelta(text: string): AssistantMessageEvent {
  return { type: "toolcall_delta", contentIndex: 0, delta: text, partial: partialWithCall() } as AssistantMessageEvent;
}

function callEnd(arguments_: Record<string, unknown>, argumentsError?: string): AssistantMessageEvent {
  return {
    type: "toolcall_end",
    contentIndex: 0,
    toolCall: {
      type: "toolCall",
      id: "t1",
      name: "lookup",
      arguments: arguments_,
      ...(argumentsError !== undefined ? { argumentsError } : {}),
    },
    partial: partialWithCall(),
  } as AssistantMessageEvent;
}

function done(): AssistantMessageEvent {
  return { type: "done", reason: "toolUse", message: message() } as AssistantMessageEvent;
}

function toolCallsOf(events: ProtocolEvent[]) {
  return events.flatMap((event) => (event.type === "tool-call" ? [event.call] : []));
}

async function drain(events: AssistantMessageEvent[]): Promise<ProtocolEvent[]> {
  const output: ProtocolEvent[] = [];
  for await (const event of createPiProtocol("openai-responses", fakePi(events)).stream(BASE)) output.push(event);
  return output;
}

/** A fetch stand-in that streams `frames` as SSE, never two frames in one macrotask. */
function sseResponse(frames: readonly string[]): Response {
  const encoder = new TextEncoder();
  const pending = frames.map((frame) => encoder.encode(frame));
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      // A body that arrived as one chunk would let the terminal event be
      // handled in the same tick as the delta before it, which is not how a
      // provider delivers one, and is what kept the real-pi short of the shape
      // this story is about.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const frame = pending[index++];
      if (frame === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(frame);
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function sse(name: string, payload: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
}

const CALL_DONE_TEXT = '{"city":"KL"}';

function outputItemAdded() {
  return sse("response.output_item.added", {
    type: "response.output_item.added",
    output_index: 0,
    item: { type: "function_call", id: "fc_1", call_id: "c1", name: "lookup", arguments: "" },
  });
}

function outputItemDone(argumentsText: string) {
  return sse("response.output_item.done", {
    type: "response.output_item.done",
    output_index: 0,
    item: {
      type: "function_call",
      id: "fc_1",
      call_id: "c1",
      name: "lookup",
      arguments: argumentsText,
      status: "completed",
    },
  });
}

function responseCompleted(argumentsText: string) {
  return sse("response.completed", {
    type: "response.completed",
    response: {
      id: "resp_1",
      status: "completed",
      output: [
        {
          type: "function_call",
          id: "fc_1",
          call_id: "c1",
          name: "lookup",
          arguments: argumentsText,
          status: "completed",
        },
      ],
      usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
    },
  });
}

const DONE_SENTINEL = "data: [DONE]\n\n";

/** `client.complete` through the real pi-ai backend, with only fetch stubbed. */
async function completeThroughRealPi(frames: readonly string[]): Promise<CompleteResult> {
  vi.stubGlobal("fetch", async () => sseResponse(frames));
  const credentials = createMemoryCredentialStore({ openai: { kind: "api-key", key: "sk-test" } });
  const protocols: ProtocolFactory = ({ providerOverrides }) => defaultProtocols({ credentials, providerOverrides });
  const client = createClient({ providers: await defaultProviders(), protocols, transportRetries: 0 });
  const model = await client.model("openai", "gpt-5.4");
  const req: ClientRequest = {
    messages: [{ role: "user", content: "where" }],
    tools: [LOOKUP_TOOL],
  };
  return client.complete(model, req);
}

describe("createPiProtocol completed tool arguments", () => {
  it("AC-1 emits the completed arguments when the streamed deltas disagree", async () => {
    const events = await drain([argumentsDelta('{"city":"SG"}'), callEnd({ city: "KL" }), done()]);

    expect(toolCallsOf(events)).toEqual([{ id: "t1", name: "lookup", input: { city: "KL" } }]);
  });

  it("AC-2 emits the completed arguments when no delta arrived at all", async () => {
    const events = await drain([callEnd({ city: "KL" }), done()]);

    expect(toolCallsOf(events)).toEqual([{ id: "t1", name: "lookup", input: { city: "KL" } }]);
  });

  it("AC-3 (control) keeps the completed arguments when the deltas agree", async () => {
    const events = await drain([argumentsDelta('{"city":"KL"}'), callEnd({ city: "KL" }), done()]);

    expect(toolCallsOf(events)).toEqual([{ id: "t1", name: "lookup", input: { city: "KL" } }]);
  });

  it("AC-4 falls back to the parsed accumulation when pi reports argumentsError", async () => {
    const events = await drain([
      argumentsDelta('{"city":"SG"}'),
      callEnd({}, "Tool arguments must be a JSON object"),
      done(),
    ]);

    expect(toolCallsOf(events)).toEqual([{ id: "t1", name: "lookup", input: { city: "SG" } }]);
  });

  it("AC-5 (control) ends with a bad-request error when the accumulation is not JSON", async () => {
    const events = await drain([argumentsDelta('{"city"'), callEnd({ city: "KL" })]);

    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: { kind: "bad-request", message: 'Tool "lookup" returned unparseable arguments.' },
    });
  });

  it("AC-6 (control) yields no tool-call when the accumulation is not JSON", async () => {
    const events = await drain([argumentsDelta('{"city"'), callEnd({ city: "KL" })]);

    expect(toolCallsOf(events)).toEqual([]);
  });

  it("AC-9 (control) emits terminal usage before the bad-request error while draining", async () => {
    const events = await drain([
      argumentsDelta('{"city"'),
      callEnd({ city: "KL" }),
      { type: "done", reason: "toolUse", message: message({ usage: { ...message().usage, input: 100, output: 20 } }) },
    ]);

    const types = events.map((event) => event.type);
    expect(types).toEqual(["tool-call-partial", "usage", "error"]);
    expect(events[1]).toEqual({
      type: "usage",
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 2, cacheWriteTokens: 1 },
    });
    expect(events[2]).toMatchObject({
      type: "error",
      error: { kind: "bad-request", message: 'Tool "lookup" returned unparseable arguments.' },
    });
  });
});

describe("createClient completed tool arguments (real pi-ai)", () => {
  it("AC-7 resolves the arguments pi reports on output_item.done when no delta streamed", async () => {
    const result = await completeThroughRealPi([
      outputItemAdded(),
      outputItemDone(CALL_DONE_TEXT),
      responseCompleted(CALL_DONE_TEXT),
      DONE_SENTINEL,
    ]);

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls?.[0]?.name).toBe("lookup");
    expect(result.toolCalls?.[0]?.input).toEqual({ city: "KL" });
  });

  it("AC-8 prefers the completed arguments over a disagreeing argument delta", async () => {
    const delta = sse("response.function_call_arguments.delta", {
      type: "response.function_call_arguments.delta",
      output_index: 0,
      item_id: "fc_1",
      delta: '{"city":"SG"}',
    });
    const result = await completeThroughRealPi([
      outputItemAdded(),
      delta,
      outputItemDone(CALL_DONE_TEXT),
      responseCompleted(CALL_DONE_TEXT),
      DONE_SENTINEL,
    ]);

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls?.[0]?.name).toBe("lookup");
    expect(result.toolCalls?.[0]?.input).toEqual({ city: "KL" });
  });
});
